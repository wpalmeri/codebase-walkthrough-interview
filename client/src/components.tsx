import type { ReactNode } from "react";

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">—</span>;
  return (
    <span className={`badge s-${status}`}>
      <span className="badge-dot" />
      {status.charAt(0) + status.slice(1).toLowerCase()}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  flush,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      <div className={flush ? "card-body flush" : "card-body"}>{children}</div>
    </section>
  );
}

export function PageHeader({
  crumbs,
  title,
  titleExtra,
  subtitle,
  actions,
}: {
  crumbs?: { label: string; to?: string }[];
  title: string;
  titleExtra?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      {crumbs && crumbs.length > 0 && (
        <div className="crumbs">
          {crumbs.map((crumb, i) => (
            <span key={i}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {crumb.to ? <a href={`#${crumb.to}`}>{crumb.label}</a> : <span>{crumb.label}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="page-header-row">
        <div>
          <h2 className="page-title">
            {title}
            {titleExtra}
          </h2>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---- icons: 16px, stroke currentColor ---- */

function svg(path: ReactNode) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const icons = {
  orders: svg(
    <>
      <path d="M6.3 5h13.2l-1.5 8.5a2 2 0 0 1-2 1.7H9.4a2 2 0 0 1-2-1.6L5.6 3.6A2 2 0 0 0 3.7 2H2.5" />
      <circle cx="9.5" cy="20" r="1.6" />
      <circle cx="16.5" cy="20" r="1.6" />
    </>
  ),
  invoices: svg(
    <>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  products: svg(
    <>
      <path d="M21 8.5v7a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4a2 2 0 0 1-1-1.7v-7a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.7z" />
      <path d="M3.3 7.3 12 12.3l8.7-5" />
      <path d="M12 22V12.3" />
    </>
  ),
  cash: svg(
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10h.01M18 14h.01" />
    </>
  ),
  reports: svg(
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M8 16v-5M13 16V8M18 16v-8" />
    </>
  ),
  lock: svg(
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  comment: svg(
    <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
  back: svg(<path d="M19 12H5m0 0 6-6m-6 6 6 6" />),
};
