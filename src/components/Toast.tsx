import type { ToastState } from '../types';

interface Props {
  toast: ToastState | null;
}

export default function Toast({ toast }: Props) {
  return (
    <div className={`toast-wrap ${toast ? 'is-visible' : ''}`} aria-live="polite">
      {toast && <div className={`toast toast--${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}