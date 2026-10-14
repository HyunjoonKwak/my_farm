"use client";

import { Eye, Loader2, Plus, RotateCcw, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MAX_DIGEST_ITEMS } from "@/lib/validations/market-digest";
import { MarketDigestItemEditor } from "./MarketDigestItemEditor";
import { useState } from "react";
import { useMarketDigestSettings, type DigestDelivery, type DigestItemDraft, type DigestKind } from "./useMarketDigestSettings";

const DELIVERY_LABELS: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  SENT: { label: "발송", variant: "default" },
  EMPTY_SENT: { label: "발송(거래 없음)", variant: "secondary" },
  SENDING: { label: "발송 중", variant: "outline" },
  UNKNOWN: { label: "확인 필요", variant: "outline" },
  FAILED: { label: "실패", variant: "destructive" },
};

const KIND_LABELS: Record<DigestKind, string> = { daily: "일일 브리핑", weekly: "주간 리포트" };

const NEW_ITEM: DigestItemDraft = { productName: "토마토", label: "", varieties: [], origin: "", enabled: true };

function moveItem(items: DigestItemDraft[], index: number, offset: -1 | 1): DigestItemDraft[] {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function DeliveryList({ deliveries }: { deliveries: DigestDelivery[] }) {
  if (deliveries.length === 0) return <p className="text-xs text-muted-foreground">아직 발송 이력이 없습니다.</p>;
  return (
    <ul className="space-y-1">
      {deliveries.map((delivery) => {
        const badge = DELIVERY_LABELS[delivery.status] ?? { label: delivery.status, variant: "outline" as const };
        return (
          <li key={`${delivery.channel}-${delivery.dateKey}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="tabular-nums">{delivery.dateKey}</span>
            <span className="text-muted-foreground">{delivery.channel === "telegram-weekly" ? "주간" : "일일"}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {delivery.error && <span className="text-muted-foreground">{delivery.error}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function MarketDigestSettings() {
  const { state, draft, setDraft, dirty, saving, sending, preview, previewLoading, save, reset, loadPreview, clearPreview, sendTest } =
    useMarketDigestSettings();
  const [kind, setKind] = useState<DigestKind>("daily");

  if (!state || !draft) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const setItems = (items: DigestItemDraft[]) => setDraft({ ...draft, items });
  const updateItem = (index: number, item: DigestItemDraft) =>
    setItems(draft.items.map((current, i) => (i === index ? item : current)));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
          <Send className="h-5 w-5" />
          텔레그램 시세 브리핑
          <Badge variant={state.telegramConfigured ? "default" : "outline"}>
            {state.telegramConfigured ? "텔레그램 연결됨" : "텔레그램 미설정"}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          자동 수집이 끝나면 매일 브리핑(전국 기준 흐름·주의 신호)을, 주 초(월요일 수집분, 늦어지면 수요일까지)에는 지난주 주간
          리포트(전년 비교·출하 법인 비교)를 보냅니다. 비교 산지를 고르면 그 산지 가격이 전국과 얼마나 다른지, 평소 범위를 벗어났는지 함께 알려 줍니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!state.hasSettings && (
          <p className="text-sm text-amber-600 dark:text-amber-400">먼저 위의 자동 수집 설정을 저장해 주세요.</p>
        )}

        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
          <Label htmlFor="digest-enabled" className="text-sm">브리핑 받기</Label>
          <Switch
            id="digest-enabled"
            checked={draft.digestEnabled}
            onCheckedChange={(digestEnabled) => setDraft({ ...draft, digestEnabled })}
          />
        </div>

        <div className="space-y-3">
          {draft.items.map((item, index) => (
            <MarketDigestItemEditor
              key={index}
              item={item}
              index={index}
              count={draft.items.length}
              collected={state.targetProducts.includes(item.productName)}
              onChange={(next) => updateItem(index, next)}
              onMove={(offset) => setItems(moveItem(draft.items, index, offset))}
              onRemove={() => setItems(draft.items.filter((_, i) => i !== index))}
            />
          ))}
          <Button
            variant="outline"
            className="w-full"
            disabled={draft.items.length >= MAX_DIGEST_ITEMS}
            onClick={() => setItems([...draft.items, NEW_ITEM])}
          >
            <Plus className="mr-2 h-4 w-4" />
            항목 추가
          </Button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button className="sm:flex-1" disabled={!dirty || saving || !state.hasSettings} onClick={save}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            저장
          </Button>
          <Button variant="outline" disabled={!dirty || saving} onClick={reset}>
            <RotateCcw className="mr-2 h-4 w-4" />
            되돌리기
          </Button>
          <div className="flex rounded-md border p-0.5" role="group" aria-label="미리보기·테스트 종류">
            {(Object.keys(KIND_LABELS) as DigestKind[]).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={kind === value ? "secondary" : "ghost"}
                className="flex-1"
                aria-pressed={kind === value}
                onClick={() => {
                  setKind(value);
                  clearPreview();
                }}
              >
                {KIND_LABELS[value]}
              </Button>
            ))}
          </div>
          <Button variant="outline" disabled={dirty || previewLoading} onClick={() => loadPreview(kind)}>
            {previewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
            미리보기
          </Button>
          <Button variant="outline" disabled={dirty || sending || !state.telegramConfigured} onClick={() => sendTest(kind)}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            테스트 발송
          </Button>
        </div>
        {dirty && <p className="text-xs text-muted-foreground">미리보기·테스트 발송은 저장한 설정으로 만듭니다.</p>}

        {preview && (
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs leading-relaxed">{preview}</pre>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">최근 발송</p>
          <DeliveryList deliveries={state.deliveries} />
        </div>
      </CardContent>
    </Card>
  );
}
