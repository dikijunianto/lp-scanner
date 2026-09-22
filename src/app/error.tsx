"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="empty">
      <h1>Unable to display this page</h1>
      <p>Try again. Existing scanner history is retained.</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
