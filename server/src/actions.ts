import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
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

const bookmarkOut = z.object({
  id: z.number(),
  url: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  tags: z.string(),
  memo: z.string(),
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
      return {
        total: rows.length,
        bookmarks: filtered.map((r) => ({
          id: r.id,
          url: r.url,
          title: r.title,
          summary: r.summary,
          category: r.category,
          tags: r.tags,
          memo: r.memo,
          created_at: r.createdAt.toISOString(),
          updated_at: r.updatedAt.toISOString(),
        })),
      };
    },
  }),

  fetchPreview: defineAction({
    request: z.object({ url: z.string().min(1) }),
    response: z.object({
      url: z.string(),
      title: z.string(),
      summary: z.string(),
      siteName: z.string(),
      ok: z.boolean(),
    }),
    async handler(_ctx, args) {
      const found = extractUrlFromText(args.url) ?? args.url;
      const url = normalizeUrl(found);
      let title = "";
      let summary = "";
      let siteName = "";
      try { siteName = new URL(url).hostname.replace(/^www\./, ""); } catch { siteName = ""; }
      let ok = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 7000);
        const res = await fetch(url, {
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
          ok = true;
        }
      } catch { /* fallback below */ }
      if (!title) title = siteName || url;
      if (summary.length > 280) summary = summary.slice(0, 277) + "…";
      return { url, title, summary, siteName, ok };
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
    }),
    response: z.object({ id: z.number(), duplicated: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const url = normalizeUrl(extractUrlFromText(args.url) ?? args.url);
      const existing = await db.select().from(schema.bookmarks);
      const dup = existing.find((r) => r.url === url);
      if (dup) return { id: dup.id, duplicated: true };
      const now = new Date();
      const title = args.title.trim() || (() => { try { return new URL(url).hostname; } catch { return url; } })();
      const res = await db.insert(schema.bookmarks).values({
        url, title, summary: args.summary.trim(), category: args.category.trim() || "기타",
        tags: args.tags.trim(), memo: args.memo.trim(), createdAt: now, updatedAt: now,
      }).returning({ id: schema.bookmarks.id });
      const row = res[0];
      if (!row) throw new Error("insert failed");
      ctx.invalidateQueries();
      return { id: row.id, duplicated: false };
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
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.update(schema.bookmarks).set({
        title: args.title.trim(), summary: args.summary.trim(),
        category: args.category.trim() || "기타", tags: args.tags.trim(),
        memo: args.memo.trim(), url: normalizeUrl(args.url), updatedAt: new Date(),
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
      await db.delete(schema.bookmarks).where(eq(schema.bookmarks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
