'use client';

import { useEffect, useRef, useState } from 'react';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

let cssInjected = false;
let jsLoading: Promise<void> | null = null;

function ensureLeaflet(): Promise<void> {
  if (typeof window !== 'undefined' && (window as unknown as { L?: unknown }).L) {
    return Promise.resolve();
  }
  if (!cssInjected) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
    cssInjected = true;
  }
  if (!jsLoading) {
    jsLoading = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LEAFLET_JS;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('地图组件加载失败（Leaflet CDN 不可达）'));
      document.head.appendChild(s);
    });
  }
  return jsLoading;
}

export interface MapPickerProps {
  /** 当前纬度（字符串或数字，空串表示未设置） */
  lat: string | number;
  /** 当前经度 */
  lng: string | number;
  /** 回填父组件：写入经纬度 */
  onChange: (lat: number, lng: number) => void;
  /** 地图高度 */
  height?: number;
}

function toNum(v: string | number): number | null {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function MapPicker({ lat, lng, onChange, height = 320 }: MapPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ map: unknown; marker: unknown } | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draftLat, setDraftLat] = useState<string>(lat === '' || lat == null ? '' : String(lat));
  const [draftLng, setDraftLng] = useState<string>(lng === '' || lng == null ? '' : String(lng));

  // 初始化地图（仅一次）
  useEffect(() => {
    let destroyed = false;
    ensureLeaflet()
      .then(() => {
        if (destroyed || !containerRef.current) return;
        const L = (window as unknown as { L: any }).L;
        const initLat = toNum(lat) ?? 39.9042; // 默认北京
        const initLng = toNum(lng) ?? 116.4074;
        const map = L.map(containerRef.current, { center: [initLat, initLng], zoom: 13 });
        const tile = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap',
          maxZoom: 19,
        });
        tile.addTo(map);
        const marker = L.marker([initLat, initLng], { draggable: true }).addTo(map);

        const emit = (la: number, ln: number) => {
          setDraftLat(String(la));
          setDraftLng(String(ln));
          onChange(la, ln);
        };
        map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
          marker.setLatLng(e.latlng);
          emit(e.latlng.lat, e.latlng.lng);
        });
        marker.on('dragend', () => {
          const p = marker.getLatLng();
          emit(p.lat, p.lng);
        });

        mapRef.current = { map, marker };
        setReady(true);
        // 容器在弹窗中可能初始尺寸为 0，强制刷新
        setTimeout(() => map.invalidateSize(), 200);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : '地图加载失败'));

    return () => {
      destroyed = true;
      if (mapRef.current) {
        (mapRef.current.map as { remove: () => void }).remove();
        mapRef.current = null;
      }
    };
    // 仅在挂载时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 手动输入经纬度后，同步 Marker 与地图视图 */
  const applyManual = (la: number, ln: number) => {
    if (mapRef.current) {
      const L = (window as unknown as { L: any }).L;
      (mapRef.current.marker as any).setLatLng([la, ln]);
      (mapRef.current.map as any).setView([la, ln], ((mapRef.current.map as any).getZoom()));
    }
    onChange(la, ln);
  };

  return (
    <div>
      <div
        ref={containerRef}
        style={{
          height,
          width: '100%',
          borderRadius: 'var(--radius-sm, 8px)',
          border: '1px solid var(--border)',
          background: '#eef1f5',
        }}
      />
      {err && (
        <p style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)', margin: '6px 0 0' }}>{err}</p>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
          纬度
          <input
            className="form-input"
            style={{ width: 130 }}
            inputMode="decimal"
            value={draftLat}
            onChange={(e) => {
              setDraftLat(e.target.value);
              const la = toNum(e.target.value);
              const ln = toNum(draftLng);
              if (la != null && ln != null && ready) applyManual(la, ln);
            }}
          />
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-sm)' }}>
          经度
          <input
            className="form-input"
            style={{ width: 130 }}
            inputMode="decimal"
            value={draftLng}
            onChange={(e) => {
              setDraftLng(e.target.value);
              const la = toNum(draftLat);
              const ln = toNum(e.target.value);
              if (la != null && ln != null && ready) applyManual(la, ln);
            }}
          />
        </label>
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--fg-tertiary)' }}>
          点击地图或拖动标记选取位置；坐标采用 WGS-84（与设备 GPS 一致）
        </span>
      </div>
    </div>
  );
}
