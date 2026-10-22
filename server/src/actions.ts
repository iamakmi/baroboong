import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";

function normalizeUrl(raw: string): string {
  let u = raw.trim();
  if (!u) return u;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}
function extractUrlFromText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0];
  const m2 = text.match(/(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);
  return m2 ? m2[0] : null;
}
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
function metaContent(html: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]);
  }
  return "";
}

type PageMeta = { title: string; summary: string; siteName: string; imageUrl: string; ok: boolean };

async function fetchPageMeta(pageUrl: string): Promise<PageMeta> {
  let title = "";
  let summary = "";
  let imageUrl = "";
  let siteName = "";
  try { siteName = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { siteName = ""; }
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const res = await fetch(pageUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", Accept: "text/html,*/*" },
      redirect: "follow",
    });
    clearTimeout(t);
    if (res.ok) {
      const html = (await res.text()).slice(0, 300000);
      title = metaContent(html, [
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
        /<title[^>]*>([^<]+)<\/title>/i,
      ]);
      summary = metaContent(html, [
        /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i,
      ]);
      const ogSite = metaContent(html, [
        /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i,
      ]);
      if (ogSite) siteName = ogSite;
      const rawImage = metaContent(html, [
        /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
        /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
      ]);
      if (rawImage) {
        try { imageUrl = new URL(rawImage, res.url || pageUrl).href; } catch { imageUrl = ""; }
      }
      ok = true;
    }
  } catch { /* fallback below */ }
  if (!title) title = siteName || pageUrl;
  if (summary.length > 280) summary = summary.slice(0, 277) + "…";
  return { title, summary, siteName, imageUrl, ok };
}

const THUMB_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "jpg",
};

// Download the page's og:image and store the bytes in this artifact's own
// blob storage. Returns the blob key, or "" when there is no usable image.
async function storeThumb(ctx: Ctx, imageUrl: string, keyHint: string): Promise<string> {
  if (!imageUrl) return "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(imageUrl, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", Accept: "image/*" },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return "";
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ct.startsWith("image/")) return "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 5_000_000) return "";
    const ext = THUMB_EXT[ct] ?? "jpg";
    const key = `thumbs/${keyHint}.${ext}`;
    await ctx.blobs.put(key, bytes, { contentType: ct === "image/avif" ? "image/jpeg" : ct });
    return key;
  } catch {
    return "";
  }
}

// Fetch one screenshot-service URL and return validated image bytes.
async function fetchCaptureBytes(src: string, timeoutMs: number): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(src, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", Accept: "image/*" },
      redirect: "follow",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!ct.startsWith("image/")) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Real page screenshots are well above a few KB; tiny responses are
    // placeholders / error tiles, not captures.
    if (bytes.length < 6000 || bytes.length > 6_000_000) return null;
    return { bytes, contentType: ct };
  } catch {
    return null;
  }
}

// Take a screenshot ("capture") of the bookmarked page itself via public
// screenshot services, and store the bytes in this artifact's own blob
// storage. Returns the blob key, or "" when no service produced a capture.
async function storeCapture(ctx: Ctx, pageUrl: string, keyHint: string, fullChain: boolean): Promise<string> {
  const candidates: { src: string; timeoutMs: number }[] = [
    { src: `https://image.thum.io/get/width/1024/crop/768/noanimate/${pageUrl}`, timeoutMs: 12000 },
    { src: `https://mini.s-shot.ru/1024x768/${pageUrl}`, timeoutMs: 12000 },
  ];
  if (fullChain) {
    candidates.push({ src: `https://s0.wp.com/mshots/v1/${encodeURIComponent(pageUrl)}?w=1024`, timeoutMs: 10000 });
  }
  for (const c of candidates) {
    let hit = await fetchCaptureBytes(c.src, c.timeoutMs);
    // mShots answers with a small "generating" placeholder on first request;
    // give it one short retry so we store the real capture, not the placeholder.
    if (!hit && c.src.includes("mshots")) {
      await new Promise((r) => setTimeout(r, 3500));
      hit = await fetchCaptureBytes(c.src, c.timeoutMs);
    }
    if (!hit) continue;
    const ext = THUMB_EXT[hit.contentType] ?? "jpg";
    const key = `captures/${keyHint}.${ext}`;
    await ctx.blobs.put(key, hit.bytes, { contentType: hit.contentType === "image/avif" ? "image/jpeg" : hit.contentType });
    return key;
  }
  return "";
}

const bookmarkOut = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  tags: z.string(),
  memo: z.string(),
  thumb_url: z.string(),
  capture_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const Actions = {
  listBookmarks: defineAction({
    request: z.object({
      query: z.string().default(""),
      category: z.string().default(""),
    }),
    response: z.object({ bookmarks: z.array(bookmarkOut), total: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookmarks).orderBy(desc(schema.bookmarks.createdAt));
      let filtered = rows;
      if (args.category && args.category !== "전체") {
        filtered = filtered.filter((r) => r.category === args.category);
      }
      if (args.query.trim()) {
        const q = args.query.trim().toLowerCase();
        filtered = filtered.filter((r) =>
          [r.title, r.summary, r.url, r.tags, r.category, r.memo].join(" ").toLowerCase().includes(q)
        );
      }
      const bookmarks = await Promise.all(
        filtered.map(async (r) => ({
          id: r.id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          category: r.category,
          tags: r.tags,
          memo: r.memo,
          thumb_url: r.thumbnailBlobKey ? await ctx.blobs.getUrl(r.thumbnailBlobKey) : "",
          capture_url: r.captureBlobKey ? await ctx.blobs.getUrl(r.captureBlobKey) : "",
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        }))
      );
      return { total: rows.length, bookmarks };
    },
  }),

  fetchPreview: defineAction({
    request: z.object({ url: z.string().min(1) }),
    response: z.object({
      url: z.string(),
      title: z.string(),
      summary: z.string(),
      siteName: z.string(),
      imageUrl: z.string(),
      ok: z.boolean(),
    }),
    async handler(_ctx, args) {
      const found = extractUrlFromText(args.url) ?? args.url;
      const url = normalizeUrl(found);
      const meta = await fetchPageMeta(url);
      return { url, title: meta.title, summary: meta.summary, siteName: meta.siteName, imageUrl: meta.imageUrl, ok: meta.ok };
    },
  }),

  addBookmark: defineAction({
    request: z.object({
      url: z.string().min(1),
      title: z.string().default(""),
      summary: z.string().default(""),
      category: z.string().default("기타"),
      tags: z.string().default(""),
      memo: z.string().default(""),
      imageUrl: z.string().default(""),
    }),
    response: z.object({ id: z.number(), duplicated: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const url = normalizeUrl(extractUrlFromText(args.url) ?? args.url);
      const existing = await db.select().from(schema.bookmarks);
      const dup = existing.find((r) => r.url === url);
      if (dup) {
        // Already saved: backfill a missing thumbnail / capture from this fetch.
        if (!dup.thumbnailBlobKey && args.imageUrl) {
          const key = await storeThumb(ctx, args.imageUrl, `b${dup.id}`);
          if (key) await db.update(schema.bookmarks).set({ thumbnailBlobKey: key }).where(eq(schema.bookmarks.id, dup.id));
        }
        if (!dup.captureBlobKey) {
          const capKey = await storeCapture(ctx, url, `b${dup.id}`, false);
          if (capKey) await db.update(schema.bookmarks).set({ captureBlobKey: capKey }).where(eq(schema.bookmarks.id, dup.id));
        }
        return { id: dup.id, duplicated: true };
      }
      const now = new Date();
      const title = args.title.trim() || (() => { try { return new URL(url).hostname; } catch { return url; } })();
      const res = await db.insert(schema.bookmarks).values({
        url, title, summary: args.summary.trim(), category: args.category.trim() || "기타",
        tags: args.tags.trim(), memo: args.memo.trim(), createdAt: now, updatedAt: now,
      }).returning({ id: schema.bookmarks.id });
      const row = res[0];
      if (!row) throw new Error("insert failed");
      const key = await storeThumb(ctx, args.imageUrl, `b${row.id}`);
      if (key) await db.update(schema.bookmarks).set({ thumbnailBlobKey: key }).where(eq(schema.bookmarks.id, row.id));
      const capKey = await storeCapture(ctx, url, `b${row.id}`, false);
      if (capKey) await db.update(schema.bookmarks).set({ captureBlobKey: capKey }).where(eq(schema.bookmarks.id, row.id));
      ctx.invalidateQueries();
      return { id: row.id, duplicated: false };
    },
  }),

  refreshThumbnail: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true), found: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; found: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      const row = rows[0];
      if (!row) return { ok: true, found: false };
      const meta = await fetchPageMeta(row.url);
      const key = meta.imageUrl ? await storeThumb(ctx, meta.imageUrl, `b${row.id}`) : "";
      if (key) {
        await db.update(schema.bookmarks).set({ thumbnailBlobKey: key }).where(eq(schema.bookmarks.id, row.id));
        ctx.invalidateQueries();
        return { ok: true, found: true };
      }
      return { ok: true, found: false };
    },
  }),

  refreshCapture: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true), found: z.boolean() }),
    async handler(ctx, args): Promise<{ ok: true; found: boolean }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      const row = rows[0];
      if (!row) return { ok: true, found: false };
      const key = await storeCapture(ctx, row.url, `b${row.id}`, true);
      if (key) {
        if (row.captureBlobKey && row.captureBlobKey !== key) {
          try { await ctx.blobs.delete(row.captureBlobKey); } catch { /* best effort */ }
        }
        await db.update(schema.bookmarks).set({ captureBlobKey: key }).where(eq(schema.bookmarks.id, row.id));
        ctx.invalidateQueries();
        return { ok: true, found: true };
      }
      return { ok: true, found: false };
    },
  }),

  updateBookmark: defineAction({
    request: z.object({
      id: z.number(),
      title: z.string().min(1),
      summary: z.string().default(""),
      category: z.string().default("기타"),
      tags: z.string().default(""),
      memo: z.string().default(""),
      url: z.string().min(1),
      imageUrl: z.string().default(""),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const newUrl = normalizeUrl(args.url);
      const rows = await db.select().from(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      const old = rows[0];
      const urlChanged = !old || old.url !== newUrl;
      let thumbKey: string | undefined;
      let captureKey: string | undefined;
      if (urlChanged) {
        // URL changed: the old thumbnail / capture no longer represent this link.
        thumbKey = args.imageUrl ? await storeThumb(ctx, args.imageUrl, `b${args.id}`) : "";
        if (old?.thumbnailBlobKey && old.thumbnailBlobKey !== thumbKey) {
          try { await ctx.blobs.delete(old.thumbnailBlobKey); } catch { /* best effort */ }
        }
        captureKey = await storeCapture(ctx, newUrl, `b${args.id}`, false);
        if (old?.captureBlobKey && old.captureBlobKey !== captureKey) {
          try { await ctx.blobs.delete(old.captureBlobKey); } catch { /* best effort */ }
        }
      }
      await db.update(schema.bookmarks).set({
        title: args.title.trim(), summary: args.summary.trim(),
        category: args.category.trim() || "기타", tags: args.tags.trim(),
        memo: args.memo.trim(), url: newUrl, updatedAt: new Date(),
        ...(thumbKey !== undefined ? { thumbnailBlobKey: thumbKey } : {}),
        ...(captureKey !== undefined ? { captureBlobKey: captureKey } : {}),
      }).where(eq(schema.bookmarks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteBookmark: defineAction({
    request: z.object({ id: z.number() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      const row = rows[0];
      await db.delete(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      if (row?.thumbnailBlobKey) {
        try { await ctx.blobs.delete(row.thumbnailBlobKey); } catch { /* best effort */ }
      }
      if (row?.captureBlobKey) {
        try { await ctx.blobs.delete(row.captureBlobKey); } catch { /* best effort */ }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
