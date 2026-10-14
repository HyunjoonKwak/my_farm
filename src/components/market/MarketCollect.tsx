"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  Trash2,
  Database,
  Download,
  Play,
  Calendar,
} from "lucide-react";
import { formatDate } from "@/lib/utils/format";
import { toast } from "sonner";
import { MARKET_PRODUCTS } from "@/lib/constants/market-products";
import { MarketCollectAutoSettings } from "./MarketCollectAutoSettings";
import { MarketCollectLogs } from "./MarketCollectLogs";
import { MarketRecoveryStatus } from "./MarketRecoveryStatus";
import { MarketDigestSettings } from "./MarketDigestSettings";

interface MarketSettings {
  autoCollectEnabled: boolean;
  collectTime: string;
  collectDaysAgo: number;
  collectDays: number[];
  corporationCodes: string[];
  targetProducts: string[];
  defaultViewDays: number;
  retentionDays: number;
  autoCleanupEnabled: boolean;
}

const AVAILABLE_PRODUCTS: readonly string[] = MARKET_PRODUCTS;

interface Corporation {
  code: string;
  name: string;
  selected: boolean;
}

interface CollectionLog {
  id: string;
  targetDate: string;
  corporation: string;
  corporationName: string;
  targetProducts: string | null;
  totalCount: number;
  newCount: number;
  duplicateCount: number;
  status: string;
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}

interface DailyData {
  date: string;
  count: number;
}

interface DataStats {
  totalCount: number;
  oldestDate: string | null;
  newestDate: string | null;
  dailyData: DailyData[];
}

interface MarketCollectProps {
  onCollectComplete?: () => void;
}

export function MarketCollect({ onCollectComplete }: MarketCollectProps) {
  const [settings, setSettings] = useState<MarketSettings | null>(null);
  const [originalSettings, setOriginalSettings] = useState<MarketSettings | null>(null);
  const [corporations, setCorporations] = useState<Corporation[]>([]);
  const [logs, setLogs] = useState<CollectionLog[]>([]);
  const [dataStats, setDataStats] = useState<DataStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [isCollecting, setIsCollecting] = useState(false);
  const [collectProgress, setCollectProgress] = useState<string>("");
  const [collectProgressPercent, setCollectProgressPercent] = useState<number>(0);
  const [collectDate, setCollectDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [collectProducts, setCollectProducts] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("market_collectProducts");
      return saved ? JSON.parse(saved) : [];
    }
    return [];
  });
  const [selectedCorps, setSelectedCorps] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("market_selectedCorps");
      return saved ? JSON.parse(saved) : ["11000101"];
    }
    return ["11000101"];
  });

  const [customProduct, setCustomProduct] = useState<string>("");
  const [autoSettingsOpen, setAutoSettingsOpen] = useState(false);

  const [deleteTargetDate, setDeleteTargetDate] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("market_collectProducts", JSON.stringify(collectProducts));
    }
  }, [collectProducts]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("market_selectedCorps", JSON.stringify(selectedCorps));
    }
  }, [selectedCorps]);

  const hasUnsavedChanges =
    settings && originalSettings
      ? JSON.stringify(settings) !== JSON.stringify(originalSettings)
      : false;

  const fetchSettings = useCallback(async () => {
    try {
      const response = await fetch("/api/market/garak/settings");
      const data = await response.json();
      setSettings(data.settings);
      setOriginalSettings(data.settings);
      setCorporations(data.availableCorporations || []);
    } catch (error) {
      console.error("Failed to fetch settings:", error);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const response = await fetch("/api/market/garak/logs?days=14");
      const data = await response.json();
      setLogs(data.logs || []);
    } catch (error) {
      console.error("Failed to fetch logs:", error);
    }
  }, []);

  const fetchDataStats = useCallback(async () => {
    try {
      const response = await fetch("/api/market/garak/cleanup?byDate=true");
      const data = await response.json();
      setDataStats(data);
    } catch (error) {
      console.error("Failed to fetch data stats:", error);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchSettings(), fetchLogs(), fetchDataStats()]).finally(() =>
      setLoading(false)
    );
  }, [fetchSettings, fetchLogs, fetchDataStats]);

  async function handleSaveSettings() {
    if (!settings) return;
    setSaving(true);
    try {
      const response = await fetch("/api/market/garak/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        const result = await response.json();
        toast.error(result.error || "설정 저장에 실패했습니다.");
      } else {
        toast.success("설정이 저장되었습니다.");
        setOriginalSettings(settings);
      }
    } catch {
      toast.error("설정 저장 중 오류가 발생했습니다.");
    } finally {
      setSaving(false);
    }
  }

  function handleResetSettings() {
    if (originalSettings) {
      setSettings(originalSettings);
      toast.info("변경사항이 취소되었습니다.");
    }
  }

  async function handleCollectData() {
    if (selectedCorps.length === 0) {
      toast.error("수집할 법인을 선택해주세요.");
      return;
    }

    setIsCollecting(true);
    setCollectProgress("수집 준비 중...");
    setCollectProgressPercent(0);

    const totalSteps = selectedCorps.length;
    let completedSteps = 0;
    let totalNewRecords = 0;
    let totalTotalCount = 0;
    const statuses: string[] = [];
    const issues: string[] = [];
    let guidance: string | null = null;

    try {
      for (const corpCode of selectedCorps) {
        const corpName = corporations.find((c) => c.code === corpCode)?.name || corpCode;
        setCollectProgress(`${corpName} 데이터 수집 중...`);

        const response = await fetch("/api/market/garak/collect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: collectDate,
            corporationCodes: [corpCode],
            productName: collectProducts.length > 0 ? collectProducts.join(",") : undefined,
          }),
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || `${corpName} 수집 실패`);
        }

        totalNewRecords += result.newCount || 0;
        totalTotalCount += result.totalCount || 0;
        // status: SUCCESS | PARTIAL | FAILED | EMPTY (예전 응답은 noAuction만 있음)
        statuses.push(result.status ?? (result.noAuction ? "EMPTY" : "SUCCESS"));
        if (Array.isArray(result.issues)) {
          issues.push(...result.issues.map((issue: string) => `${corpName}: ${issue}`));
        }
        if (result.guidance && !guidance) guidance = result.guidance;
        completedSteps++;
        setCollectProgressPercent(Math.round((completedSteps / totalSteps) * 100));
      }

      const overall = statuses.every((s) => s === "FAILED")
        ? "FAILED"
        : statuses.some((s) => s === "FAILED" || s === "PARTIAL")
          ? "PARTIAL"
          : statuses.every((s) => s === "EMPTY")
            ? "EMPTY"
            : "SUCCESS";
      const issueText = issues.slice(0, 3).join(" / ") + (issues.length > 3 ? ` 외 ${issues.length - 3}건` : "");

      if (overall === "FAILED") {
        setCollectProgress(`수집 실패: ${issueText || "원인 확인 필요"}`);
        toast.error(`수집 실패 — ${issueText || "원인 확인 필요"}`, { duration: 8000 });
      } else if (overall === "PARTIAL") {
        setCollectProgress(`일부만 수집됨: ${issueText}`);
        toast.warning(
          `일부만 수집되었습니다 (저장 ${totalNewRecords}건). ${issueText}. ${guidance ?? "사유와 조치는 수집 로그의 안내를 확인하세요."}`,
          { duration: 10000 }
        );
      } else if (overall === "EMPTY") {
        setCollectProgress("수집된 거래 0건");
        toast.info(`${collectDate} 수집된 거래가 0건입니다. 휴장 여부는 확정하지 않습니다.`);
      } else {
        setCollectProgress("수집 완료!");
        if (totalNewRecords > 0) {
          toast.success(`${totalNewRecords}건의 새 데이터가 저장되었습니다. (조회 ${totalTotalCount}건)`);
        } else {
          toast.info(`새로운 데이터가 없습니다. (조회 ${totalTotalCount}건 모두 이미 저장됨)`);
        }
      }

      fetchDataStats();
      fetchLogs();

      if (onCollectComplete) {
        onCollectComplete();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "수집 중 오류가 발생했습니다.";
      setCollectProgress(`오류: ${message}`);
      toast.error(message);
    } finally {
      setTimeout(() => {
        setIsCollecting(false);
        setCollectProgress("");
        setCollectProgressPercent(0);
      }, 2000);
    }
  }

  async function handleDeleteDateData(date: string) {
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/market/garak?date=${date}`, { method: "DELETE" });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "삭제 실패");
      }

      toast.success(`${formatDate(date)} 데이터 ${result.deletedCount}건이 삭제되었습니다.`);
      setDeleteTargetDate(null);
      fetchDataStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : "삭제 중 오류가 발생했습니다.";
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  }

  function toggleCollectProduct(product: string) {
    setCollectProducts((prev) =>
      prev.includes(product) ? prev.filter((p) => p !== product) : [...prev, product]
    );
  }

  function toggleCollectCorp(code: string) {
    setSelectedCorps((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  function handleAddCustomProduct() {
    if (!customProduct.trim()) return;
    const products = customProduct.split(",").map((p) => p.trim()).filter(Boolean);
    setCollectProducts((prev) => [...new Set([...prev, ...products])]);
    setCustomProduct("");
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Data collection card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Download className="h-4 w-4 sm:h-5 sm:w-5" />
            데이터 수집
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            가락시장 경매 데이터를 수집합니다.
            {dataStats?.newestDate && (
              <span className="block sm:inline sm:ml-2 text-primary font-medium mt-1 sm:mt-0">
                최신: {formatDate(dataStats.newestDate)}
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 sm:space-y-6">
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <Calendar className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              수집 날짜
            </Label>
            <Input
              type="date"
              value={collectDate}
              onChange={(e) => setCollectDate(e.target.value)}
              className="w-full sm:w-64"
            />
          </div>

          <div className="space-y-2 sm:space-y-3">
            <Label className="text-sm">수집 품목 (미선택시 전체)</Label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {AVAILABLE_PRODUCTS.slice(0, 14).map((product) => (
                <Button
                  key={product}
                  variant={collectProducts.includes(product) ? "default" : "outline"}
                  size="sm"
                  className="h-7 sm:h-8 text-xs sm:text-sm px-2 sm:px-3"
                  onClick={() => toggleCollectProduct(product)}
                >
                  {product}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="직접 입력 (쉼표 구분)"
                value={customProduct}
                onChange={(e) => setCustomProduct(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddCustomProduct()}
                className="flex-1 text-sm"
              />
              <Button variant="outline" size="sm" onClick={handleAddCustomProduct}>
                추가
              </Button>
            </div>
            {collectProducts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {collectProducts.map((p) => (
                  <Badge
                    key={p}
                    variant="secondary"
                    className="cursor-pointer text-xs"
                    onClick={() => toggleCollectProduct(p)}
                  >
                    {p} ×
                  </Badge>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 text-[10px] sm:text-xs px-2"
                  onClick={() => setCollectProducts([])}
                >
                  전체 해제
                </Button>
              </div>
            )}
          </div>

          <div className="space-y-2 sm:space-y-3">
            <Label className="text-sm">수집 법인</Label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {corporations.map((corp) => (
                <Button
                  key={corp.code}
                  variant={selectedCorps.includes(corp.code) ? "default" : "outline"}
                  size="sm"
                  className="h-7 sm:h-8 text-xs sm:text-sm px-2 sm:px-3"
                  onClick={() => toggleCollectCorp(corp.code)}
                >
                  {corp.name}
                </Button>
              ))}
            </div>
          </div>

          {isCollecting && (
            <div className="space-y-2 p-3 sm:p-4 bg-muted rounded-lg">
              <div className="flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
                <span className="truncate">{collectProgress}</span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all duration-300"
                  style={{ width: `${collectProgressPercent}%` }}
                />
              </div>
            </div>
          )}

          <Button
            onClick={handleCollectData}
            disabled={isCollecting || selectedCorps.length === 0}
            className="w-full sm:w-auto"
          >
            {isCollecting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            데이터 수집 시작
          </Button>

          {settings && (
            <MarketCollectAutoSettings
              settings={settings}
              corporations={corporations}
              saving={saving}
              hasUnsavedChanges={!!hasUnsavedChanges}
              autoSettingsOpen={autoSettingsOpen}
              onAutoSettingsOpenChange={setAutoSettingsOpen}
              onSettingsChange={setSettings}
              onSave={handleSaveSettings}
              onReset={handleResetSettings}
            />
          )}
        </CardContent>
      </Card>

      {/* Stored data stats by date */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Database className="h-4 w-4 sm:h-5 sm:w-5" />
            저장된 데이터
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            날짜별 시세 데이터 현황
            {dataStats && (
              <span className="ml-2 font-medium text-foreground">
                총 {dataStats.totalCount.toLocaleString()}건
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {dataStats?.dailyData && dataStats.dailyData.length > 0 ? (
            <div className="rounded-md border overflow-x-auto -mx-4 sm:mx-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">날짜</TableHead>
                    <TableHead className="text-right whitespace-nowrap">건수</TableHead>
                    <TableHead className="w-[60px] sm:w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dataStats.dailyData.map((item) => (
                    <TableRow key={item.date}>
                      <TableCell className="font-medium text-xs sm:text-sm whitespace-nowrap">
                        {formatDate(item.date)}
                      </TableCell>
                      <TableCell className="text-right text-xs sm:text-sm whitespace-nowrap">
                        {item.count.toLocaleString()}건
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 sm:h-8 sm:w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => setDeleteTargetDate(item.date)}
                        >
                          <Trash2 className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground text-sm">
              저장된 데이터가 없습니다.
            </div>
          )}
        </CardContent>
      </Card>

      <MarketRecoveryStatus />

      <MarketDigestSettings />

      <MarketCollectLogs logs={logs} />

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTargetDate} onOpenChange={() => setDeleteTargetDate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>데이터 삭제 확인</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTargetDate && formatDate(deleteTargetDate)} 날짜의 모든 데이터를 삭제합니다.
              삭제된 데이터는 복구할 수 없습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTargetDate && handleDeleteDateData(deleteTargetDate)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              삭제
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
