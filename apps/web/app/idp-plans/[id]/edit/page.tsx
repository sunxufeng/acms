'use client';

import { useParams } from 'next/navigation';
import PlanForm from '../../../../components/idp/PlanForm';

export default function EditIdpPlanPage() {
  const params = useParams<{ id: string }>();
  return <PlanForm planId={params.id} />;
}
