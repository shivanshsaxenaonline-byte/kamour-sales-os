type TableSkeletonProps = {
  rows?: number;
  columns?: number;
  metrics?: boolean;
  label?: string;
};

const widths = ['72%', '48%', '86%', '60%', '38%', '76%', '54%', '68%'];

function Bar({ width = '100%', className = '' }: { width?: string; className?: string }) {
  return <span className={`loading-bar ${className}`} style={{ width }} />;
}

export function TableSkeleton({
  rows = 12,
  columns = 7,
  metrics = false,
  label = 'Loading page',
}: TableSkeletonProps) {
  return (
    <div className="page-skeleton" role="status" aria-label={label} aria-live="polite">
      <span className="sr-only">{label}</span>
      {metrics ? (
        <div className="loading-metrics" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="loading-metric" key={index}>
              <Bar width="54%" />
              <Bar width={index % 2 ? '46%' : '68%'} className="loading-bar-lg" />
              <Bar width="76%" />
            </div>
          ))}
        </div>
      ) : null}
      <div className="loading-toolbar" aria-hidden="true">
        <Bar width="116px" className="loading-bar-title" />
        <Bar width="82px" />
        <Bar width="96px" />
        <Bar width="190px" className="loading-push" />
        <Bar width="30px" />
      </div>
      <div className="loading-table" aria-hidden="true">
        <div className="loading-row loading-row-head">
          {Array.from({ length: columns }, (_, column) => (
            <Bar key={column} width={widths[(column + 2) % widths.length]} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, row) => (
          <div className="loading-row" key={row}>
            {Array.from({ length: columns }, (_, column) => (
              <Bar key={column} width={widths[(row + column) % widths.length]} />
            ))}
          </div>
        ))}
      </div>
      <div className="loading-footer" aria-hidden="true">
        <Bar width="96px" />
        <Bar width="138px" />
      </div>
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="loading-workspace" role="status" aria-label="Loading workspace" aria-live="polite">
      <span className="sr-only">Loading workspace</span>
      <div className="loading-windowbar" aria-hidden="true"><Bar width="112px" /><Bar width="74px" /></div>
      <div className="loading-shell">
        <aside className="loading-sidebar" aria-hidden="true">
          <div className="loading-brand"><Bar width="28px" className="loading-brand-mark" /><Bar width="92px" className="loading-bar-title" /></div>
          <Bar width="70px" />
          <div className="loading-nav">
            {Array.from({ length: 8 }, (_, index) => <Bar key={index} width={index % 3 === 0 ? '78%' : '92%'} />)}
          </div>
          <div className="loading-nav loading-nav-bottom">
            {Array.from({ length: 3 }, (_, index) => <Bar key={index} width={index === 2 ? '86%' : '72%'} />)}
          </div>
        </aside>
        <TableSkeleton />
      </div>
    </div>
  );
}

export function LoginSkeleton() {
  return (
    <main className="login-page loading-login-modern" role="status" aria-label="Loading sign in" aria-live="polite">
      <span className="sr-only">Loading sign in</span>
      <section className="login-workspace" aria-hidden="true">
        <div className="login-people">
          <Bar width="160px" /><div style={{ marginTop: 20 }}><Bar width="75%" className="loading-bar-lg" /></div>
          <div className="login-profile-grid">
            {Array.from({ length: 9 }, (_, i) => <div className="login-profile" key={i}>
              <span className="loading-bar" style={{ width: 46, height: 46, borderRadius: '50%', marginBottom: 10 }} />
              <Bar width="65%" /><Bar width="40%" />
            </div>)}
          </div>
        </div>
        <div className="login-access"><div className="login-welcome"><span className="login-spinner" /><p>Preparing your workspace</p></div></div>
      </section>
    </main>
  );
}
