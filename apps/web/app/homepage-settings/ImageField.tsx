'use client';

import { useRef, useState } from 'react';
import { imageUrl } from '@acms/contracts';
import { api } from '../../lib/api';

interface ImageFieldProps {
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function ImageField({ label, value, onChange, placeholder }: ImageFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadFile(file);
      if (res.file_token) onChange(res.file_token);
    } catch (err) {
      alert(`上传失败：${err instanceof Error ? err.message : '未知错误'}`);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const previewUrl = imageUrl(value || '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-secondary)' }}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder || '图片 URL 或上传后显示 file_token'}
        />
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '上传中…' : '上传'}
        </button>
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
      </div>
      {previewUrl && (
        <div
          style={{
            width: '100%',
            height: 80,
            borderRadius: 6,
            border: '1px solid var(--border)',
            backgroundImage: `url(${previewUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
    </div>
  );
}
