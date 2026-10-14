"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

interface MarketDigestPickerProps {
  options: string[];
  selected: string[];
  multiple: boolean;
  /** 아무것도 고르지 않았을 때의 의미 (예: "전체 산지", "자동: 물량 최다 품종") */
  noneLabel: string;
  loading?: boolean;
  onChange: (next: string[]) => void;
}

/** 검색 가능한 단일/다중 선택. 저장된 값이 옵션 목록에 없어도 선택 상태로 보여준다. */
export function MarketDigestPicker({ options, selected, multiple, noneLabel, loading, onChange }: MarketDigestPickerProps) {
  const [open, setOpen] = useState(false);
  const merged = [...new Set([...selected, ...options])];
  const summary = selected.length === 0
    ? noneLabel
    : selected.length === 1 ? selected[0] : `${selected[0]} 외 ${selected.length - 1}개`;

  const toggle = (value: string) => {
    if (!multiple) {
      onChange(selected[0] === value ? [] : [value]);
      setOpen(false);
      return;
    }
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full min-w-0 justify-between font-normal">
          <span className={cn("truncate text-left", selected.length === 0 && "text-muted-foreground")}>{summary}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="검색" />
          <CommandList>
            <CommandEmpty>{loading ? "불러오는 중…" : "결과가 없습니다."}</CommandEmpty>
            <CommandGroup>
              <CommandItem value={`__none__ ${noneLabel}`} onSelect={() => { onChange([]); setOpen(false); }}>
                <Check className={cn("h-4 w-4", selected.length === 0 ? "opacity-100" : "opacity-0")} />
                {noneLabel}
              </CommandItem>
              {merged.map((option) => (
                <CommandItem key={option} value={option} onSelect={() => toggle(option)}>
                  <Check className={cn("h-4 w-4", selected.includes(option) ? "opacity-100" : "opacity-0")} />
                  {option}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
