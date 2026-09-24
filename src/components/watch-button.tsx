"use client";
import { useState } from "react";
import { useData } from "./use-data";
export function WatchButton({ poolId }: { poolId: string }) {
  const { data, refresh } = useData<{ poolIds: string[] }>("/api/watchlist", 60000);
  const [busy, setBusy] = useState(false);
  const watched = data?.poolIds.includes(poolId) ?? false;
  const toggle = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poolId, watched: !watched }),
      });
      if (response.ok) refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="watch-button"
      aria-pressed={watched}
      disabled={busy || !data}
      onClick={toggle}
      title="Watch locally for higher enrichment priority"
    >
      {watched ? "★ Watched" : "☆ Watch"}
    </button>
  );
}
