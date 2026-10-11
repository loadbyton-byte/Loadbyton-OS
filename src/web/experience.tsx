import type { Child } from 'hono/jsx';

export function Icon({ name = 'grid' }: { name?: string }) {
  const paths: Record<string, string> = {
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    arrow: 'M4 12h16 M14 6l6 6-6 6',
    shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    truck: 'M2 6h12v11H2z M14 10h4l4 4v3h-8 M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4 M18 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
    document: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    money: 'M3 5h18v14H3z M7 9h.01 M17 15h.01 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    people: 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M2 21v-3a6 6 0 0 1 12 0v3 M17 4a4 4 0 0 1 0 8 M17 15a5 5 0 0 1 5 5v1',
    clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M12 6v6l4 2',
  };
  return <svg class="ui-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.grid} /></svg>;
}

export function AuthFrame({ signup = false, children }: { signup?: boolean; children: Child }) {
  return <section class={`auth-layout ${signup ? 'auth-signup' : ''}`}>
    <aside class="auth-story">
      <img class="auth-photo" src="/assets/freight/port.webp" alt="" />
      <div class="auth-story-content">
        <span class="eyebrow">YOUR LOGISTICS. CONNECTED.</span>
        <h2>{signup ? 'A new chapter.\nOne workspace.' : 'Back to the\noperating record.'}</h2>
        <p>From the first enquiry to the final collection. Give every team one place to move the work forward.</p>
        <div class="auth-proofs">
          <div><Icon name="shield" /><span><strong>Your company, your records</strong><small>Tenant isolation and role-based access.</small></span></div>
          <div><Icon name="document" /><span><strong>Evidence stays with the work</strong><small>Documents, approvals and milestones together.</small></span></div>
          <div><Icon name="money" /><span><strong>Keep the margin in view</strong><small>Separate estimates from reconciled outcomes.</small></span></div>
        </div>
        <a href="/security" class="auth-trust">Explore our security controls <Icon name="arrow" /></a>
      </div>
    </aside>
    <div class="auth-main"><div class="auth-panel">{children}</div></div>
  </section>;
}

export function WorkspaceTools({ title, tenantName, nav }: { title: string; tenantName: string; nav: { href: string; label: string; section?: string }[] }) {
  return <>
    <div class="workspace-bar"><div><span class="workspace-label">{tenantName}</span><span class="workspace-divider">/</span><span>{title}</span></div>
      <button class="workspace-search" type="button" data-command-open hidden><Icon name="search" /><span>Find a page</span><kbd>Ctrl K</kbd></button>
      <button class="mobile-workspace-menu" type="button" data-sidebar-toggle aria-expanded="false" aria-controls="workspace-sidebar" hidden>Menu</button>
    </div>
    <dialog class="command-dialog" data-command-dialog aria-labelledby="command-title">
      <div class="command-head"><h2 id="command-title">Go to a page</h2><button type="button" class="btn ghost sm" data-command-close>Close</button></div>
      <label class="sr-only" for="command-query">Search workspace pages</label><input id="command-query" type="search" placeholder="Search pages…" autocomplete="off" />
      <nav class="command-results" aria-label="Page search">{nav.map(n => <a href={n.href}><Icon name="arrow" /><span>{n.label}<small>{n.section || 'Workspace'}</small></span></a>)}</nav>
      <p class="command-empty" hidden>No matching pages. Try another name.</p>
      <div class="command-foot">Search the pages available to your role. Escape to close.</div>
    </dialog>
  </>;
}
