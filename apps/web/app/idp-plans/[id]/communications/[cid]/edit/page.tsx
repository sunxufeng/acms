'use client';

import { useParams } from 'next/navigation';
import CommunicationForm from '../../../../../../components/idp/CommunicationForm';

export default function EditCommunicationPage() {
  const params = useParams<{ cid: string }>();
  return <CommunicationForm commId={params.cid} />;
}
