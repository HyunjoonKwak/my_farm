"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { DigestItemInput } from "@/lib/validations/market-digest";

export type DigestItemDraft = DigestItemInput;
export type DigestKind = "daily" | "weekly";

export interface DigestDelivery {
  channel: string;
  dateKey: string;
  status: string;
  error: string | null;
  updatedAt: string;
}

export interface DigestState {
  hasSettings: boolean;
  digestEnabled: boolean;
  targetProducts: string[];
  items: DigestItemDraft[];
  telegramConfigured: boolean;
  deliveries: DigestDelivery[];
}

const ITEMS_URL = "/api/market/garak/digest/items";
const DIGEST_URL = "/api/market/garak/digest";

const OUTCOME_MESSAGES: Record<string, string> = {
  SENT: "텔레그램으로 보냈습니다.",
  SKIPPED: "요약이 꺼져 있거나 텔레그램이 설정되지 않아 보내지 않았습니다.",
  DUPLICATE: "이 날짜 요약은 이미 보냈습니다.",
  UNKNOWN: "응답이 늦어 전송 여부를 확인하지 못했습니다. 텔레그램을 확인해 주세요.",
  FAILED: "텔레그램 발송에 실패했습니다.",
  ERROR: "요약을 만드는 중 오류가 발생했습니다.",
};

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "요청에 실패했습니다.");
  return body as T;
}

export function useMarketDigestSettings() {
  const [state, setState] = useState<DigestState | null>(null);
  const [draft, setDraft] = useState<{ digestEnabled: boolean; items: DigestItemDraft[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const applyState = useCallback((next: DigestState) => {
    setState(next);
    setDraft({ digestEnabled: next.digestEnabled, items: next.items });
  }, []);

  const load = useCallback(async () => {
    try {
      applyState(await readJson<DigestState>(await fetch(ITEMS_URL)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "요약 설정을 불러오지 못했습니다.");
    }
  }, [applyState]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = Boolean(
    state && draft && JSON.stringify({ digestEnabled: state.digestEnabled, items: state.items }) !== JSON.stringify(draft)
  );

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await fetch(ITEMS_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      applyState(await readJson<DigestState>(response));
      toast.success("텔레그램 요약 설정을 저장했습니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [draft, applyState]);

  const loadPreview = useCallback(async (kind: DigestKind) => {
    setPreviewLoading(true);
    try {
      const body = await readJson<{ text: string | null }>(await fetch(`${DIGEST_URL}?kind=${kind}`));
      setPreview(body.text ?? "요약이 꺼져 있거나 켜진 항목이 없습니다. 저장한 설정 기준으로 만듭니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "미리보기를 만들지 못했습니다.");
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const sendTest = useCallback(async (kind: DigestKind) => {
    setSending(true);
    try {
      const response = await fetch(DIGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test: true, kind }),
      });
      const { outcome } = await readJson<{ outcome: string }>(response);
      const message = OUTCOME_MESSAGES[outcome] ?? outcome;
      if (outcome === "SENT") toast.success(message);
      else toast.warning(message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "테스트 발송에 실패했습니다.");
    } finally {
      setSending(false);
    }
  }, []);

  const clearPreview = useCallback(() => setPreview(null), []);

  const reset = useCallback(() => {
    if (state) setDraft({ digestEnabled: state.digestEnabled, items: state.items });
  }, [state]);

  return { state, draft, setDraft, dirty, saving, sending, preview, previewLoading, save, reset, loadPreview, clearPreview, sendTest };
}
