'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { imageUrl } from '@acms/contracts';
import { api } from '../../lib/api';

interface ImageFieldProps {
  label: string;
  value: string | null | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function ImageField({ label, value, onChange, placeholder }: ImageFieldProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [value]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const res = await api.uploadFile(file);
      if (res.file_token) onChange(res.file_token);
    } catch (err) {
      alert(t('uploadFailedMsg', { msg: err instanceof Error ? err.message : t('unknownError') }));
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
          placeholder={placeholder || t('imageUrlPlaceholder')}
        />
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? tc('uploading') : t('upload')}
        </button>
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFile} />
      </div>
      {previewUrl && !imgError ? (
        <img
          src={previewUrl}
          alt={t('preview')}
          onError={() => setImgError(true)}
          style={{
            width: '100%',
            height: 80,
            borderRadius: 6,
            border: '1px solid var(--border)',
            objectFit: 'contain',
            background: 'var(--bg-secondary)',
          }}
        />
      ) : previewUrl ? (
        <div
          style={{
            width: '100%',
            height: 80,
            borderRadius: 6,
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            color: 'var(--fg-tertiary)',
            background: 'var(--bg-secondary)',
          }}
        >
          图片无法加载，请检查链接或重新上传
        </div>
      ) : null}
    </div>
  );
}
