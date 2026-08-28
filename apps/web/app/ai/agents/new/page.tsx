'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentForm } from '../AgentForm';

export default function NewAgentPage() {
  const router = useRouter();
  return (
    <AgentForm onDone={() => router.push('/ai/agents')} />
  );
}
