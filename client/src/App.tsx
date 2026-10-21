import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";

type Bookmark = ApiResponse<typeof api, "listBookmarks">["bookmarks"][number];
type Preview = ApiResponse<typeof api, "fetchPreview">;

const CATEGORIES = ["업무", "공부", "뉴스·정보", "영상", "쇼핑", "맛집·레시피", "여행", "개발", "기타"] as const;

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function dateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.floor((startOf(now) - startOf(d)) / 86400000);
  if (diffDays <= 0) return "오늘";
  if (diffDays === 1) return "어제";
  if (diffDays < 7) return "이번 주";
  return "이전";
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const GROUP_ORDER = ["오늘", "어제", "이번 주", "이전"];

export function App() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("전체");
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const checkedClip = useRef(false);

  // form state for new bookmark (after preview)
  const [fTitle, setFTitle] = useState("");
  const [fSummary, setFSummary] = useState("");
  const [fCategory, setFCategory] = useState<string>("기타");
  const [fTags, setFTags] = useState("");
  const [fMemo, setFMemo] = useState("");

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  }, []);

  const list = useQuery({
    queryKey: ["bookmarks", search, catFilter],
    queryFn: () => api.listBookmarks({ query: search, category: catFilter }),
  });
  const all = useQuery({
    queryKey: ["bookmarks-all"],
    queryFn: () => api.listBookmarks({ query: "", category: "전체" }),
  });
  const bookmarks = list.data?.bookmarks ?? [];
  const total = all.data?.total ?? 0;
  const existingUrls = useMemo(() => new Set((all.data?.bookmarks ?? []).map((b) => b.url)), [all.data]);

  const previewMut = useMutation({
    mutationFn: (url: string) => api.fetchPreview({ url }),
    onSuccess: (p) => {
      setPreview(p);
      setFTitle(p.title);
      setFSummary(p.summary);
      showToast(p.ok ? "링크 정보를 가져왔어요" : "링크는 저장할 수 있지만 제목을 직접 확인해 주세요");
    },
    onError: () => showToast("링크를 읽지 못했어요. 직접 입력해 저장할 수 있어요"),
  });

  const addMut = useMutation({
    mutationFn: () =>
      api.addBookmark({
        url: preview?.url ?? pasteText,
        title: fTitle, summary: fSummary, category: fCategory, tags: fTags, memo: fMemo,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["bookmarks"] });
      qc.invalidateQueries({ queryKey: ["bookmarks-all"] });
      setPreview(null); setPasteText(""); setFTitle(""); setFSummary(""); setFTags(""); setFMemo(""); setClipUrl(null);
      showToast(r.duplicated ? "이미 저장된 링크예요" : "⚡ 바로붕! 저장 완료");
    },
    onError: () => showToast("저장에 실패했어요. 다시 시도해 주세요"),
  });

  const quickAddMut = useMutation({
    mutationFn: async (url: string) => {
      const p = await api.fetchPreview({ url });
      return api.addBookmark({ url: p.url, title: p.title, summary: p.summary, category: "기타", tags: "", memo: "" });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["bookmarks"] });
      qc.invalidateQueries({ queryKey: ["bookmarks-all"] });
      setClipUrl(null);
      showToast(r.duplicated ? "이미 저장된 링크예요" : "⚡ 복사한 링크를 바로 저장했어요");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteBookmark({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bookmarks"] });
      qc.invalidateQueries({ queryKey: ["bookmarks-all"] });
      setConfirmDelete(null);
      showToast("삭제했어요");
    },
  });

  const tryReadClipboard = useCallback(async () => {
    try {
      if (!navigator.clipboard?.readText) return;
      const text = await navigator.clipboard.readText();
      const m = text.match(/https?:\/\/[^\s<>"']+/i);
      if (m && !existingUrls.has(m[0])) setClipUrl(m[0]);
    } catch { /* permission denied — silent */ }
  }, [existingUrls]);

  useEffect(() => {
    if (!checkedClip.current) { checkedClip.current = true; void tryReadClipboard(); }
    const onFocus = () => { void tryReadClipboard(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [tryReadClipboard]);

  const handlePasteButton = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) { setPasteText(text.trim()); previewMut.mutate(text.trim()); }
      else showToast("클립보드가 비어 있어요. 링크를 복사한 뒤 눌러주세요");
    } catch {
      showToast("클립보드 권한이 없어요. 아래 칸에 길게 눌러 붙여넣어 주세요");
    }
  };

  const handleShare = async (b: Bookmark) => {
    const shareData = { title: b.title, text: b.summary ? `${b.title}\n${b.summary}` : b.title, url: b.url };
    try {
      if (navigator.share) { await navigator.share(shareData); return; }
      throw new Error("no share");
    } catch {
      try { await navigator.clipboard.writeText(`${b.title}\n${b.url}`); showToast("링크를 복사했어요 — 원하는 곳에 붙여넣으세요"); }
      catch { showToast("공유를 열 수 없어요"); }
    }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, Bookmark[]>();
    for (const b of bookmarks) {
      const g = dateGroup(b.created_at);
      const arr = map.get(g) ?? [];
      arr.push(b); map.set(g, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g) ?? [] }));
  }, [bookmarks]);

  const usedCategories = useMemo(() => {
    const s = new Set((all.data?.bookmarks ?? []).map((b) => b.category));
    return ["전체", ...CATEGORIES.filter((c) => s.has(c) || true)];
  }, [all.data]);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] pb-24">
      {/* Header — 바로붕 */}
      <header className="sticky top-0 z-20 bg-[var(--bg)]/95 backdrop-blur pt-safe">
        <div className="px-4 pt-4 pb-2 flex items-center gap-2.5 max-w-xl mx-auto">
          <div className="w-10 h-10 rounded-2xl bg-[var(--accent)] flex items-center justify-center text-white text-xl font-black shadow-lg shadow-orange-500/25" aria-hidden>⚡</div>
          <div className="flex-1">
            <h1 className="text-[22px] leading-6 font-black tracking-tight">바로붕 <span className="text-[13px] font-bold text-[var(--dim)]">Baroboong</span></h1>
            <p className="text-[12px] text-[var(--dim)] font-medium">빠른즐겨찾기 · 복사하면 바로 저장</p>
          </div>
          <div className="text-right">
            <div className="text-[20px] font-black leading-5">{total}</div>
            <div className="text-[11px] text-[var(--dim)] font-semibold">저장된 링크</div>
          </div>
        </div>
      </header>

      <main className="px-4 max-w-xl mx-auto space-y-4">
        {/* Clipboard detected banner */}
        {clipUrl && (
          <section aria-label="복사한 링크 감지" className="rounded-[var(--radius)] bg-[#17171F] text-white p-4 shadow-xl">
            <p className="text-[13px] font-bold text-orange-300">📋 복사한 링크를 발견했어요!</p>
            <p className="mt-1 text-[13px] break-all line-clamp-2 opacity-90">{clipUrl}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => quickAddMut.mutate(clipUrl)} disabled={quickAddMut.isPending}
                className="flex-1 h-11 rounded-xl bg-[var(--accent)] text-white font-extrabold text-[15px] disabled:opacity-50" aria-label="복사한 링크 바로 저장하기">
                {quickAddMut.isPending ? "저장 중…" : "⚡ 바로 저장하기"}
              </button>
              <button type="button" onClick={() => { setPasteText(clipUrl); setClipUrl(null); previewMut.mutate(clipUrl); }}
                className="h-11 px-4 rounded-xl bg-white/15 font-bold text-[14px]" aria-label="복사한 링크 내용 확인하고 저장하기">확인 후 저장</button>
              <button type="button" onClick={() => setClipUrl(null)} className="h-11 px-3 rounded-xl bg-white/10 font-bold text-[14px]" aria-label="복사한 링크 알림 닫기">닫기</button>
            </div>
          </section>
        )}

        {/* Paste zone — hero */}
        <section aria-label="링크 붙여넣기" className="rounded-[var(--radius)] bg-[var(--surface)] border-2 border-dashed border-[var(--accent)]/50 p-4 shadow-sm">
          <h2 className="font-black text-[17px]">링크 붙여넣으면 바로붕!</h2>
          <p className="text-[13px] text-[var(--dim)] mt-0.5">복사한 링크를 붙여넣으면 제목과 핵심 요약을 자동으로 가져와요.</p>
          <label htmlFor="paste-input" className="sr-only">링크 붙여넣기</label>
          <textarea id="paste-input" value={pasteText} rows={2}
            onChange={(e) => setPasteText(e.target.value)}
            onPaste={(e) => { const t = e.clipboardData.getData("text"); if (t.includes("http")) setTimeout(() => previewMut.mutate(t), 50); }}
            placeholder="https:// 링크를 여기에 붙여넣으세요"
            className="mt-3 w-full rounded-xl bg-[var(--surface2)] px-3 py-3 text-[15px] outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none break-all" />
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={handlePasteButton}
              className="flex-1 h-12 rounded-xl bg-[var(--surface2)] border border-[var(--border)] font-extrabold text-[15px]" aria-label="클립보드에서 붙여넣기">
              📋 클립보드 붙여넣기
            </button>
            <button type="button" disabled={!pasteText.trim() || previewMut.isPending} onClick={() => previewMut.mutate(pasteText)}
              className="flex-1 h-12 rounded-xl bg-[var(--accent)] text-white font-extrabold text-[15px] disabled:opacity-40 shadow-lg shadow-orange-500/20" aria-label="링크 정보 가져오기">
              {previewMut.isPending ? "가져오는 중…" : "⚡ 정보 가져오기"}
            </button>
          </div>

          {/* Preview / summary box form */}
          {preview && (
            <div className="mt-4 rounded-xl bg-[var(--surface2)] p-3.5 space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-8 h-8 rounded-lg bg-[var(--accent)] text-white flex items-center justify-center font-black text-[15px]" aria-hidden>{(domainOf(preview.url)[0] ?? "B").toUpperCase()}</span>
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-[var(--dim)]">{domainOf(preview.url)}</p>
                  <p className="text-[11px] truncate opacity-70">{preview.url}</p>
                </div>
              </div>
              <div>
                <label htmlFor="f-title" className="text-[12px] font-extrabold">제목</label>
                <input id="f-title" aria-label="제목" value={fTitle} onChange={(e) => setFTitle(e.target.value)}
                  className="mt-1 w-full h-11 rounded-lg bg-[var(--surface)] px-3 text-[15px] font-semibold outline-none focus:ring-2 focus:ring-[var(--accent)]" />
              </div>
              <div>
                <label htmlFor="f-summary" className="text-[12px] font-extrabold">💡 핵심내용 요약</label>
                <textarea id="f-summary" aria-label="핵심내용 요약" value={fSummary} onChange={(e) => setFSummary(e.target.value)} rows={3}
                  placeholder="핵심 내용을 요약해 두면 나중에 찾기 쉬워요"
                  className="mt-1 w-full rounded-lg bg-[var(--surface)] px-3 py-2.5 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none" />
              </div>
              <div>
                <span className="text-[12px] font-extrabold">분류</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="분류 선택">
                  {CATEGORIES.map((c) => (
                    <button key={c} type="button" onClick={() => setFCategory(c)} aria-pressed={fCategory === c} aria-label={`분류 ${c}`}
                      className={`h-9 px-3.5 rounded-full text-[13px] font-bold ${fCategory === c ? "bg-[var(--accent)] text-white" : "bg-[var(--surface)] border border-[var(--border)]"}`}>{c}</button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="f-tags" className="text-[12px] font-extrabold">주제·태그</label>
                  <input id="f-tags" aria-label="주제 태그" value={fTags} onChange={(e) => setFTags(e.target.value)} placeholder="예: 전주, 인테리어"
                    className="mt-1 w-full h-10 rounded-lg bg-[var(--surface)] px-3 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
                <div>
                  <label htmlFor="f-memo" className="text-[12px] font-extrabold">메모</label>
                  <input id="f-memo" aria-label="메모" value={fMemo} onChange={(e) => setFMemo(e.target.value)} placeholder="나중에 볼 이유"
                    className="mt-1 w-full h-10 rounded-lg bg-[var(--surface)] px-3 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)]" />
                </div>
              </div>
              <button type="button" onClick={() => addMut.mutate()} disabled={addMut.isPending}
                className="w-full h-12 rounded-xl bg-[var(--accent)] text-white font-black text-[16px] disabled:opacity-50" aria-label="즐겨찾기 저장하기">
                {addMut.isPending ? "저장 중…" : "⚡ 바로붕 저장하기"}
              </button>
            </div>
          )}
        </section>

        {/* Search */}
        <section aria-label="검색 및 분류 필터" className="space-y-2.5">
          <label htmlFor="search-input" className="sr-only">주제 내용으로 찾기</label>
          <div className="relative">
            <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[16px]" aria-hidden>🔍</span>
            <input id="search-input" aria-label="주제 내용으로 찾기" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="주제, 내용, 태그로 찾기"
              className="w-full h-12 rounded-full bg-[var(--surface)] border border-[var(--border)] pl-10 pr-10 text-[15px] outline-none focus:ring-2 focus:ring-[var(--accent)] shadow-sm" />
            {search && <button type="button" onClick={() => setSearch("")} aria-label="검색어 지우기" className="absolute right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-[var(--surface2)] font-bold">×</button>}
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4" role="group" aria-label="분류 필터">
            {usedCategories.map((c) => (
              <button key={c} type="button" onClick={() => setCatFilter(c)} aria-pressed={catFilter === c} aria-label={`분류 필터 ${c}`}
                className={`shrink-0 h-9 px-4 rounded-full text-[13px] font-bold whitespace-nowrap ${catFilter === c ? "bg-[#17171F] text-white dark:bg-white dark:text-black" : "bg-[var(--surface)] border border-[var(--border)]"}`}>{c}</button>
            ))}
          </div>
        </section>

        {/* List grouped by date */}
        {list.isPending ? (
          <p className="text-center py-16 text-[var(--dim)] font-semibold" role="status">불러오는 중…</p>
        ) : bookmarks.length === 0 ? (
          <section className="text-center py-14 px-6 rounded-[var(--radius)] bg-[var(--surface)] border border-[var(--border)]" aria-label="저장된 링크 없음">
            <div className="text-5xl" aria-hidden>⚡</div>
            <h2 className="mt-3 font-black text-[18px]">{total === 0 ? "아직 저장한 링크가 없어요" : "검색 결과가 없어요"}</h2>
            <p className="mt-1.5 text-[14px] text-[var(--dim)] leading-relaxed">{total === 0 ? "어디서든 링크를 복사한 뒤 바로붕을 열면, 복사한 링크를 바로 저장할 수 있어요." : "다른 주제나 단어로 다시 찾아보세요."}</p>
          </section>
        ) : (
          grouped.map(({ group, items }) => (
            <section key={group} aria-label={`${group} 저장한 링크`}>
              <h2 className="flex items-baseline gap-2 px-1 mb-2 mt-2">
                <span className="font-black text-[16px]">{group}</span>
                <span className="text-[12px] font-bold text-[var(--dim)]">{items.length}개</span>
              </h2>
              <div className="space-y-2.5">
                {items.map((b) => (
                  <article key={b.id} className="rounded-[var(--radius)] bg-[var(--surface)] border border-[var(--border)] p-4 shadow-sm">
                    <div className="flex gap-3">
                      <span className="shrink-0 w-11 h-11 rounded-xl bg-[var(--surface2)] text-[var(--accent)] flex items-center justify-center font-black text-[18px]" aria-hidden>{(domainOf(b.url)[0] ?? "B").toUpperCase()}</span>
                      <div className="min-w-0 flex-1">
                        <a href={b.url} target="_blank" rel="noreferrer" className="font-extrabold text-[15px] leading-snug line-clamp-2 hover:underline" aria-label={`${b.title} 열기`}>{b.title}</a>
                        <p className="text-[12px] text-[var(--dim)] truncate mt-0.5">{domainOf(b.url)} · {fmtDate(b.created_at)}</p>
                      </div>
                      <span className="shrink-0 h-6 px-2 rounded-full bg-[var(--mint)]/15 text-emerald-700 dark:text-emerald-300 text-[11px] font-extrabold flex items-center">{b.category}</span>
                    </div>
                    {b.summary && (
                      <div className="mt-3 rounded-xl bg-[var(--surface2)] px-3 py-2.5" aria-label="핵심내용 요약">
                        <p className="text-[11px] font-black text-[var(--accent)]">💡 핵심 요약</p>
                        <p className="text-[13.5px] leading-relaxed mt-0.5 line-clamp-3">{b.summary}</p>
                      </div>
                    )}
                    {(b.tags || b.memo) && (
                      <p className="mt-2 text-[12.5px] text-[var(--dim)]">
                        {b.tags && <span className="font-bold">{b.tags.split(",").map((t) => `#${t.trim()}`).join(" ")}</span>}
                        {b.memo && <span>{b.tags ? " · " : ""}{b.memo}</span>}
                      </p>
                    )}
                    {confirmDelete === b.id ? (
                      <div className="mt-3 flex gap-2 items-center rounded-xl bg-red-50 dark:bg-red-950/40 p-2.5">
                        <p className="flex-1 text-[13px] font-bold px-1">정말 삭제할까요?</p>
                        <button type="button" onClick={() => deleteMut.mutate(b.id)} className="h-9 px-4 rounded-lg bg-red-500 text-white font-extrabold text-[13px]" aria-label={`${b.title} 삭제 확인`}>삭제</button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="h-9 px-4 rounded-lg bg-[var(--surface)] border border-[var(--border)] font-bold text-[13px]" aria-label="삭제 취소">취소</button>
                      </div>
                    ) : (
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        <a href={b.url} target="_blank" rel="noreferrer" className="h-10 rounded-lg bg-[#17171F] text-white dark:bg-white dark:text-black flex items-center justify-center font-extrabold text-[13px]" aria-label={`${b.title} 열기`}>열기</a>
                        <button type="button" onClick={() => handleShare(b)} className="h-10 rounded-lg bg-[var(--surface2)] font-extrabold text-[13px]" aria-label={`${b.title} 공유하기`}>공유</button>
                        <button type="button" onClick={() => setEditing(b)} className="h-10 rounded-lg bg-[var(--surface2)] font-extrabold text-[13px]" aria-label={`${b.title} 수정하기`}>수정</button>
                        <button type="button" onClick={() => setConfirmDelete(b.id)} className="h-10 rounded-lg bg-[var(--surface2)] text-red-500 font-extrabold text-[13px]" aria-label={`${b.title} 삭제하기`}>삭제</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))
        )}
      </main>

      {/* Edit sheet */}
      {editing && <EditSheet bookmark={editing} onClose={() => setEditing(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ["bookmarks"] }); qc.invalidateQueries({ queryKey: ["bookmarks-all"] }); setEditing(null); showToast("수정했어요"); }} />}

      {/* Toast */}
      {toast && <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 bg-[#17171F] text-white text-[14px] font-bold px-4 py-3 rounded-full shadow-2xl max-w-[92vw] text-center">{toast}</div>}
    </div>
  );
}

function EditSheet({ bookmark, onClose, onSaved }: { bookmark: Bookmark; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(bookmark.title);
  const [url, setUrl] = useState(bookmark.url);
  const [summary, setSummary] = useState(bookmark.summary);
  const [category, setCategory] = useState(bookmark.category);
  const [tags, setTags] = useState(bookmark.tags);
  const [memo, setMemo] = useState(bookmark.memo);
  const [err, setErr] = useState("");
  const mut = useMutation({
    mutationFn: () => api.updateBookmark({ id: bookmark.id, title, url, summary, category, tags, memo }),
    onSuccess: onSaved,
    onError: () => setErr("수정에 실패했어요. 다시 시도해 주세요"),
  });
  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-end sm:items-center justify-center" role="dialog" aria-modal="true" aria-label="즐겨찾기 수정">
      <div className="w-full max-w-xl bg-[var(--surface)] rounded-t-3xl sm:rounded-3xl p-5 max-h-[92vh] overflow-y-auto pb-safe">
        <div className="flex items-center justify-between">
          <h2 className="font-black text-[18px]">바로붕 수정하기</h2>
          <button type="button" onClick={onClose} aria-label="수정 닫기" className="w-9 h-9 rounded-full bg-[var(--surface2)] font-bold">×</button>
        </div>
        <div className="mt-4 space-y-3">
          <div><label htmlFor="e-title" className="text-[12px] font-extrabold">제목</label>
            <input id="e-title" aria-label="수정 제목" value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full h-11 rounded-xl bg-[var(--surface2)] px-3 text-[15px] font-semibold outline-none focus:ring-2 focus:ring-[var(--accent)]" /></div>
          <div><label htmlFor="e-url" className="text-[12px] font-extrabold">링크</label>
            <input id="e-url" aria-label="수정 링크" value={url} onChange={(e) => setUrl(e.target.value)} className="mt-1 w-full h-11 rounded-xl bg-[var(--surface2)] px-3 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)]" /></div>
          <div><label htmlFor="e-summary" className="text-[12px] font-extrabold">💡 핵심내용 요약</label>
            <textarea id="e-summary" aria-label="수정 핵심내용 요약" value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} className="mt-1 w-full rounded-xl bg-[var(--surface2)] px-3 py-2.5 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)] resize-none" /></div>
          <div><span className="text-[12px] font-extrabold">분류</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label="수정 분류 선택">
              {CATEGORIES.map((c) => (
                <button key={c} type="button" onClick={() => setCategory(c)} aria-pressed={category === c} aria-label={`수정 분류 ${c}`}
                  className={`h-9 px-3.5 rounded-full text-[13px] font-bold ${category === c ? "bg-[var(--accent)] text-white" : "bg-[var(--surface2)]"}`}>{c}</button>
              ))}
            </div></div>
          <div className="grid grid-cols-2 gap-2">
            <div><label htmlFor="e-tags" className="text-[12px] font-extrabold">주제·태그</label>
              <input id="e-tags" aria-label="수정 태그" value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1 w-full h-10 rounded-xl bg-[var(--surface2)] px-3 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)]" /></div>
            <div><label htmlFor="e-memo" className="text-[12px] font-extrabold">메모</label>
              <input id="e-memo" aria-label="수정 메모" value={memo} onChange={(e) => setMemo(e.target.value)} className="mt-1 w-full h-10 rounded-xl bg-[var(--surface2)] px-3 text-[14px] outline-none focus:ring-2 focus:ring-[var(--accent)]" /></div>
          </div>
          {err && <p className="text-[13px] text-red-500 font-bold" role="alert">{err}</p>}
          <button type="button" disabled={!title.trim() || !url.trim() || mut.isPending} onClick={() => mut.mutate()}
            className="w-full h-12 rounded-xl bg-[var(--accent)] text-white font-black text-[16px] disabled:opacity-40" aria-label="수정 저장하기">
            {mut.isPending ? "저장 중…" : "수정 저장하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
