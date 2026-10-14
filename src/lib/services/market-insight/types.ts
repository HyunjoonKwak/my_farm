/** 시세 인사이트(일일 브리핑·주간 리포트) 공용 타입. */

/** 하루 집계 (기준 규격, 수량 가중) */
export interface DailyPoint {
  dateKey: string;
  /** Σ(가격×수량) */
  amount: number;
  /** Σ수량 */
  qty: number;
  /** 거래 건수 */
  n: number;
}

/** 품목의 기준 규격 — 최근 28일 물량으로 고정해 날마다 바뀌지 않게 한다 */
export interface ItemSpec {
  varieties: string[];
  /** 품종을 지정하지 않아 자동으로 고른 품종 (표시용) */
  autoVariety: string | null;
  grade: string;
  unit: string;
}

export interface ItemConfig {
  productName: string;
  label: string;
  varieties: string[];
  /** 비교 산지 (빈 문자열 = 비교 없음) */
  origin: string;
}

export type Status = "alert" | "watch" | "calm" | "insufficient";

export type SignalKind = "spike" | "trend" | "originGap" | "supply";

export interface Signal {
  kind: SignalKind;
  title: string;
  message: string;
}

export interface DailyInsight {
  title: string;
  spec: ItemSpec | null;
  status: Status;
  /** ⚪일 때 이유 */
  statusReason: string | null;
  today: { price: number; qty: number; n: number } | null;
  avg5: number | null;
  avg24: number | null;
  /** 오늘 가격 / 4주 평균 - 1 */
  vs4w: number | null;
  /** 5일 평균 / 전년 동기 평균 - 1 */
  yoy: number | null;
  topQuartile: number | null;
  /** 오늘 물량 / 평소(같은 요일) - 1 */
  supplyDev: number | null;
  origin: {
    name: string;
    price: number | null;
    gap: number | null;
    band: [number, number];
  } | null;
  signals: Signal[];
}
