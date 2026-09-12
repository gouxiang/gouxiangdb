// apps/web/src/components/ColorPicker.tsx
// 通用颜色选择器（被文档编辑器右键菜单"文字色/背景色"使用）
//
// 三层结构：
// 1) 简化面板（默认）：最近配色（localStorage 持久化，text/bg 独立） + 经典色板（vivid 8 + pastel 8）+ hex 输入框 + "更多颜色"入口
// 2) 完整面板（"更多颜色"按钮切换）：hue/saturation/value 2D picker + hue slider + hex 输入框
// 3) 通过 kind: "custom" 在 ContextMenu 中嵌入

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";

const RECENT_KEY_PREFIX = "gx:doc:recentColors:";
const MAX_RECENT = 8;

// 经典色板 — vivid（深饱和度）
const CLASSIC_VIVID = [
  "#000000", "#5C5C5C", "#959595", "#B7B7B7", "#D5D5D5", "#E7E7E7", "#F2F2F2", "#FFFFFF",
  "#FF4568", "#FF8C45", "#FFCE4D", "#7CD86D", "#5BC7E0", "#5E8DE0", "#9D6EE0", "#E36EE0",
];

// 经典色板 — pastel（浅饱和度）
const CLASSIC_PASTEL = [
  "#FBE6E9", "#FFE8D2", "#FAEAC9", "#E0F4E9", "#D8EAFD", "#E6E0FA", "#F2EFE7", "#FFFFFF",
  "#FFEEF0", "#FFE0CC", "#FFF2B3", "#CCEDC8", "#C2E5F0", "#CAD8FB", "#DCC1F7", "#F7C5E5",
];

export type ColorMode = "text" | "bg";

export function ColorPicker({
  mode,
  current,
  onChange,
  onClose,
}: {
  mode: ColorMode;
  /** 当前色（hex），可能为 null 表示无背景/未设置 */
  current?: string | null;
  onChange: (hex: string | null) => void;
  onClose?: () => void;
}) {
  const [recent, setRecent] = useState<string[]>([]);
  const [showFull, setShowFull] = useState(false);
  const [hexInput, setHexInput] = useState<string>(
    current ? current.toUpperCase() : "",
  );

  // 加载最近配色
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`${RECENT_KEY_PREFIX}${mode}`);
      if (raw) setRecent(JSON.parse(raw));
    } catch {
      /* localStorage 不可用 */
    }
  }, [mode]);

  /** 写入最近配色 + 触发回调 */
  const pick = (hex: string | null) => {
    if (hex) {
      const normalized = hex.toUpperCase();
      const next = [normalized, ...recent.filter((c) => c !== normalized)].slice(0, MAX_RECENT);
      setRecent(next);
      try {
        localStorage.setItem(`${RECENT_KEY_PREFIX}${mode}`, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
    }
    onChange(hex);
    onClose?.();
  };

  const onHexSubmit = () => {
    const norm = normalizeHex(hexInput);
    if (norm) pick(norm);
  };

  if (showFull) {
    return (
      <ColorPickerFull
        mode={mode}
        current={current}
        onPick={pick}
        onBack={() => setShowFull(false)}
      />
    );
  }

  return (
    <div className="kb-color-picker">
      {/* 最近配色 */}
      {recent.length > 0 && (
        <div className="kb-cp-section">
          <div className="kb-cp-label">最近配色</div>
          <div className="kb-cp-grid">
            {recent.map((c, i) => (
              <button
                key={`${c}-${i}`}
                className={`kb-cp-swatch${current?.toUpperCase() === c ? " kb-cp-swatch-active" : ""}`}
                style={{ background: c }}
                onClick={() => pick(c)}
                title={c}
                aria-label={`最近颜色 ${c}`}
              />
            ))}
          </div>
        </div>
      )}

      {/* 主色板：字体颜色/背景颜色 */}
      <div className="kb-cp-section">
        <div className="kb-cp-label-row">
          <span className="kb-cp-label">{mode === "text" ? "字体颜色" : "背景颜色"}</span>
          <span className="kb-cp-chip">经典</span>
        </div>
        <div className="kb-cp-grid">
          {CLASSIC_VIVID.map((c) => (
            <button
              key={c}
              className={`kb-cp-swatch${current?.toUpperCase() === c ? " kb-cp-swatch-active" : ""}`}
              style={{ background: c }}
              onClick={() => pick(c)}
              title={c}
              aria-label={c}
            />
          ))}
        </div>
        <div className="kb-cp-grid kb-cp-mt-4">
          {CLASSIC_PASTEL.map((c) => (
            <button
              key={c}
              className={`kb-cp-swatch${current?.toUpperCase() === c ? " kb-cp-swatch-active" : ""}`}
              style={{ background: c }}
              onClick={() => pick(c)}
              title={c}
              aria-label={c}
            />
          ))}
        </div>
        {mode === "bg" && (
          <div className="kb-cp-grid kb-cp-mt-4">
            <button
              className="kb-cp-swatch kb-cp-swatch-none"
              onClick={() => pick(null)}
              title="无背景"
              aria-label="无背景"
            />
          </div>
        )}
      </div>

      {/* hex 输入框 */}
      <div className="kb-cp-section">
        <div className="kb-cp-hex-row">
          <div
            className="kb-cp-preview"
            style={{ background: isValidHex(hexInput) ? normalizeHex(hexInput)! : "transparent" }}
          >
            {!isValidHex(hexInput) && <span className="kb-cp-preview-empty">无</span>}
          </div>
          <input
            type="text"
            value={hexInput}
            onChange={(e) => setHexInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onHexSubmit();
              }
            }}
            placeholder="#000000"
            className="kb-cp-hex-input"
            aria-label="十六进制颜色"
          />
          <button onClick={onHexSubmit} className="kb-cp-btn-primary">
            确定
          </button>
        </div>
      </div>

      {/* 完整 picker 入口 */}
      <div className="kb-cp-divider" />
      <button className="kb-cp-more" onClick={() => setShowFull(true)}>
        <Icon name="palette" size={14} />
        <span>更多颜色</span>
        <Icon name="chevronRight" size={12} className="ml-auto text-gx-text-hint" />
      </button>
    </div>
  );
}

// ============ 完整 picker（hue/s/v grid + hue slider + hex）============

function ColorPickerFull({
  mode,
  current,
  onPick,
  onBack,
}: {
  mode: ColorMode;
  current?: string | null;
  onPick: (hex: string) => void;
  onBack: () => void;
}) {
  const initHex = current || "#FF4568";
  const init = useMemo(() => hexToHsv(initHex), []);
  const [hue, setHue] = useState(init[0]);
  const [sat, setSat] = useState(init[1]);
  const [val, setVal] = useState(init[2]);
  const [hex, setHex] = useState(initHex.toUpperCase());

  // HSV 变化同步 hex
  useEffect(() => {
    setHex(hsvToHex(hue, sat, val).toUpperCase());
  }, [hue, sat, val]);

  // hex 输入同步 HSV（仅当合法）
  const onHexChange = (v: string) => {
    const upper = v.toUpperCase();
    setHex(upper);
    const norm = normalizeHex(upper);
    if (norm) {
      const [h, s, va] = hexToHsv(norm);
      setHue(h);
      setSat(s);
      setVal(va);
    }
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const updateSV = (clientX: number, clientY: number) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    const y = Math.max(0, Math.min(r.height, clientY - r.top));
    setSat((x / r.width) * 100);
    setVal(100 - (y / r.height) * 100);
  };

  const startSV = (e: React.MouseEvent) => {
    e.preventDefault();
    updateSV(e.clientX, e.clientY);
    const onMove = (ev: MouseEvent) => updateSV(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const updateHue = (clientX: number) => {
    const el = hueRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, clientX - r.left));
    setHue((x / r.width) * 360);
  };

  const startHue = (e: React.MouseEvent) => {
    e.preventDefault();
    updateHue(e.clientX);
    const onMove = (ev: MouseEvent) => updateHue(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const finalHex = hsvToHex(hue, sat, val);

  return (
    <div className="kb-color-picker-full">
      <div className="kb-cp-header">
        <button className="kb-cp-back" onClick={onBack} aria-label="返回">
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="kb-cp-title">调色板</span>
        <span className="kb-cp-mode-chip">{mode === "text" ? "字体" : "背景"}</span>
        <button
          className="kb-cp-confirm"
          onClick={() => onPick(finalHex)}
          aria-label="确定"
        >
          <Icon name="check" size={14} />
        </button>
      </div>

      {/* SV 区域：横向 saturation 0→100% (白→饱和色)，纵向 lightness 100→0% (透明→黑) */}
      <div
        ref={svRef}
        className="kb-cp-sv-area"
        style={{
          background: `linear-gradient(to right, #FFFFFF, hsl(${hue}, 100%, 50%)),
                       linear-gradient(to bottom, transparent, #000000)`,
        }}
        onMouseDown={startSV}
      >
        <div
          className="kb-cp-sv-indicator"
          style={{ left: `${sat}%`, top: `${100 - val}%` }}
        />
      </div>

      {/* hue slider */}
      <div
        ref={hueRef}
        className="kb-cp-hue-bar"
        onMouseDown={startHue}
        aria-label="色相"
      >
        <div
          className="kb-cp-hue-indicator"
          style={{ left: `${(hue / 360) * 100}%`, background: `hsl(${hue}, 100%, 50%)` }}
        />
      </div>

      {/* 预览 + hex + 不透明度（占位 100%） */}
      <div className="kb-cp-preview-row">
        <div className="kb-cp-preview-lg" style={{ background: finalHex }} />
        <input
          type="text"
          value={hex}
          onChange={(e) => onHexChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const norm = normalizeHex(hex);
              if (norm) onPick(norm);
            }
          }}
          className="kb-cp-hex-input"
          aria-label="十六进制颜色"
        />
        <span className="kb-cp-percent">100%</span>
      </div>
    </div>
  );
}

// ============ hex 工具 ============

function normalizeHex(s: string): string | null {
  const v = s.trim().replace(/^#?/, "#");
  if (/^#[0-9A-F]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9A-F]{3}$/i.test(v)) {
    return ("#" + v.slice(1).split("").map((c) => c + c).join("")).toUpperCase();
  }
  return null;
}

function isValidHex(s: string): boolean {
  return normalizeHex(s) !== null;
}

// ============ HSV ↔ hex 转换（标准算法）============

function hsvToHex(h: number, s: number, v: number): string {
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function hexToHsv(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
  }
  if (hue < 0) hue += 360;
  const sat = max === 0 ? 0 : (d / max) * 100;
  const val = max * 100;
  return [hue, sat, val];
}