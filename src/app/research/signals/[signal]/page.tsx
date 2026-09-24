import { SignalDetail } from "@/components/research";
export default async function Page({params}:{params:Promise<{signal:string}>}) {
  const {signal}=await params;
  return <SignalDetail id={Number(signal)} />;
}
