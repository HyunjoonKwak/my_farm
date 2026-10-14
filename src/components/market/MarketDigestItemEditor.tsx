"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MARKET_PRODUCTS, type MarketProduct } from "@/lib/constants/market-products";
import { MarketDigestPicker } from "./MarketDigestPicker";
import type { DigestItemDraft } from "./useMarketDigestSettings";

interface ProductFacets {
  varieties: string[];
  origins: string[];
}

// 같은 품목을 여러 항목이 쓰므로 품목별 품종·산지 목록은 한 번만 받는다
const facetCache = new Map<string, Promise<ProductFacets>>();

async function fetchList(action: "varieties" | "origins", productName: string): Promise<string[]> {
  const params = new URLSearchParams({ action, productName });
  const response = await fetch(`/api/market/garak?${params}`);
  if (!response.ok) return [];
  const body = await response.json();
  return Array.isArray(body[action]) ? body[action] : [];
}

function loadFacets(productName: string): Promise<ProductFacets> {
  const cached = facetCache.get(productName);
  if (cached) return cached;
  const pending = Promise.all([fetchList("varieties", productName), fetchList("origins", productName)])
    .then(([varieties, origins]) => ({ varieties, origins }))
    .catch(() => {
      facetCache.delete(productName);
      return { varieties: [], origins: [] };
    });
  facetCache.set(productName, pending);
  return pending;
}

interface MarketDigestItemEditorProps {
  item: DigestItemDraft;
  index: number;
  count: number;
  collected: boolean;
  onChange: (item: DigestItemDraft) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}

export function MarketDigestItemEditor({ item, index, count, collected, onChange, onMove, onRemove }: MarketDigestItemEditorProps) {
  // 품목을 바꾸면 이전 품목의 목록은 쓰지 않는다 (로딩 표시)
  const [loaded, setLoaded] = useState<{ productName: string; facets: ProductFacets } | null>(null);
  const facets = loaded?.productName === item.productName ? loaded.facets : null;

  useEffect(() => {
    let active = true;
    void loadFacets(item.productName).then((next) => {
      if (active) setLoaded({ productName: item.productName, facets: next });
    });
    return () => {
      active = false;
    };
  }, [item.productName]);

  const update = (patch: Partial<DigestItemDraft>) => onChange({ ...item, ...patch });

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={item.enabled}
          onCheckedChange={(enabled) => update({ enabled })}
          aria-label={`${item.label || item.productName} 알림 켜기`}
        />
        <Select
          value={item.productName}
          onValueChange={(productName) => update({ productName: productName as MarketProduct, varieties: [] })}
        >
          <SelectTrigger className="h-9 w-28" aria-label="품목">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MARKET_PRODUCTS.map((product) => (
              <SelectItem key={product} value={product}>{product}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={index === 0} onClick={() => onMove(-1)} aria-label="위로">
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="아래로">
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={onRemove} aria-label="항목 삭제">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">표시 이름</Label>
          <Input
            value={item.label}
            maxLength={30}
            placeholder={item.productName}
            onChange={(event) => update({ label: event.target.value })}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">비교 산지 (전국 시세와 비교)</Label>
          <MarketDigestPicker
            options={facets?.origins ?? []}
            selected={item.origin ? [item.origin] : []}
            multiple={false}
            noneLabel="비교 안 함"
            loading={!facets}
            onChange={(next) => update({ origin: next[0] ?? "" })}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">품종 (다른 표기도 함께 선택)</Label>
          <MarketDigestPicker
            options={facets?.varieties ?? []}
            selected={item.varieties}
            multiple
            noneLabel="자동: 그날 물량 최다 품종"
            loading={!facets}
            onChange={(varieties) => update({ varieties })}
          />
        </div>
      </div>

      {!collected && (
        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {item.productName}은(는) 자동 수집 품목이 아니어서 요약에 거래가 나오지 않습니다. 위 자동 수집 설정에 추가하세요.
        </p>
      )}
    </div>
  );
}
