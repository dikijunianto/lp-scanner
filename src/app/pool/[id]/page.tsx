import { notFound } from "next/navigation";
import { PoolDetail } from "@/components/pool-detail";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    notFound();
  }
  return <PoolDetail id={decoded} />;
}
