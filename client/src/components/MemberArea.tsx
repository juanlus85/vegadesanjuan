import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, CalendarDays, Check, CheckCircle2, ChevronRight, CircleAlert, CreditCard, ExternalLink, HeartHandshake, Home, LoaderCircle, LogOut, Mail, MapPin, Plus, ShieldCheck, Ticket, Trash2, UserRound, Users, WalletCards } from 'lucide-react';
import './Private.css';

type Entity = Record<string, any>;
type ApiResponse = Record<string, any>;
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function api(path: string, options: RequestInit = {}): Promise<ApiResponse> {
  let response: Response;
  try {
    response = await fetch(path, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  } catch { throw new ApiError('No se ha podido conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.', 0); }
  let data: ApiResponse = {};
  try { data = await response.json(); } catch { throw new ApiError('El servidor ha devuelto una respuesta inesperada.', response.status); }
  if (!response.ok || data.ok === false) throw new ApiError(data.error || `No se ha podido completar la operación (${response.status}).`, response.status);
  return data;
}
const send = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const value = (item: Entity | null | undefined, ...keys: string[]): any => { for (const key of keys) if (item?.[key] !== undefined && item?.[key] !== null) return item[key]; return undefined; };
const flag = (v: unknown): boolean => v === true || v === 1 || v === '1';
const money = (cents: unknown): string => cents === null || cents === undefined || cents === '' || !Number.isFinite(Number(cents)) ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(cents) / 100);
const date = (raw: unknown, withTime = false): string => {
  if (!raw) return 'Fecha por confirmar';
  const text = String(raw);
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00:00Z` : `${text.replace(' ', 'T')}${zoned ? '' : 'Z'}`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return text;
  return new Intl.DateTimeFormat('es-ES', { timeZone: zoned ? 'Europe/Madrid' : 'UTC', day: 'numeric', month: 'long', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(parsed);
};
const eventHasPassed = (raw: unknown): boolean => {
  if (!raw) return false;
  const text = String(raw);
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) return new Date(text).getTime() <= Date.now();
  const madridNow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date());
  return text.replace('T', ' ').slice(0, 19).padEnd(19, '0') <= madridNow;
};
const statusText = (s: unknown): string => ({ pending: 'Pendiente', active: 'Activa', inactive: 'Inactiva', paid: 'Pagado', exempt: 'Exento', failed: 'Fallido', refunded: 'Reembolsado', cancelled: 'Cancelado', expired: 'Caducado', needs_review: 'En revisión' }[String(s)] || (s ? String(s) : 'Sin información'));
const statusTone = (s: unknown) => ['active', 'paid'].includes(String(s)) ? 'good' : ['pending', 'needs_review'].includes(String(s)) ? 'warn' : 'neutral';
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`pv-badge pv-badge--${tone}`}><span className="pv-badge-dot" />{children}</span>; }
function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'error' | 'success' }) { return <div className={`pv-notice pv-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{kind === 'success' ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<span>{children}</span></div>; }
function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="pv-empty"><div className="pv-empty-icon">{icon}</div><strong>{title}</strong><p>{children}</p></div>; }
function safeCheckout(url: unknown) {
  if (typeof url !== 'string') throw new Error('El servidor no ha proporcionado una dirección de pago.');
  let target: URL;
  try { target = new URL(url); } catch { throw new Error('La dirección de pago recibida no es válida.'); }
  if (target.protocol !== 'https:' || !(target.hostname === 'stripe.com' || target.hostname.endsWith('.stripe.com'))) throw new Error('La dirección de pago recibida no es una página segura de Stripe.');
  window.location.assign(target.href);
}
function initials(name: unknown) { return String(name || 'S').trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(''); }

const navigation = [
  { path: '/socios', label: 'Resumen', icon: Home },
  { path: '/socios/familia', label: 'Mi familia', icon: Users },
  { path: '/socios/cuotas', label: 'Cuotas y pagos', icon: WalletCards },
  { path: '/socios/eventos', label: 'Eventos', icon: CalendarDays },
  { path: '/socios/perfil', label: 'Mi perfil', icon: UserRound },
];
function Shell({ user, children, onLogout }: { user: Entity; children: ReactNode; onLogout: () => void }) {
  const location = useLocation();
  return <div className="pv-app">
    <aside className="pv-sidebar">
      <Link to="/" className="pv-logo" aria-label="Vega de San Juan, ir al inicio"><img src="/assets/logo-web.png" alt="Vega de San Juan" /></Link>
      <div className="pv-side-label">TU ESPACIO</div>
      <nav className="pv-nav" aria-label="Navegación de socios">{navigation.map(({ path, label, icon: Icon }) => <Link key={path} to={path} className={`pv-nav-link ${location.pathname.replace(/\/$/, '') === path ? 'is-active' : ''}`}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{location.pathname.replace(/\/$/, '') === path && <ChevronRight className="pv-nav-arrow" size={16} />}</Link>)}</nav>
      <div className="pv-sidebar-bottom"><div className="pv-side-card"><HeartHandshake size={21} /><strong>Juntos hacemos barrio.</strong><span>Gracias por formar parte de nuestra comunidad.</span></div><Link className="pv-back-link" to="/"><ArrowLeft size={16} /> Volver a la web</Link></div>
    </aside>
    <div className="pv-main"><header className="pv-topbar"><span className="pv-top-label"><span className="pv-top-dot" /> ÁREA DE SOCIOS</span><div className="pv-user"><div className="pv-avatar">{initials(user.name)}</div><span className="pv-user-name">{user.name || 'Socio'}</span><button type="button" className="pv-icon-button" onClick={onLogout} aria-label="Cerrar sesión" title="Cerrar sesión"><LogOut size={18} /></button></div></header><main className="pv-content">{children}<footer className="pv-footer"><span>Vega de San Juan · San Juan de Aznalfarache</span><Link to="/contacto">¿Necesitas ayuda?</Link></footer></main></div>
  </div>;
}
function Gate({ status, error, retry }: { status: number; error: string; retry: () => void }) {
  return <div className="pv-gate"><Link to="/" className="pv-gate-logo"><img src="/assets/logo-original.png" alt="Vega de San Juan" /></Link><div className="pv-gate-card"><div className="pv-gate-icon"><ShieldCheck size={28} /></div><div className="pv-eyebrow">ÁREA PRIVADA</div><h1>{status === 401 ? 'Tu espacio te espera' : status === 403 ? 'Acceso restringido' : 'No podemos cargar tu espacio'}</h1><p>{status === 401 ? 'Inicia sesión para acceder a los datos de tu vivienda y de la asociación.' : status === 403 ? 'Tu cuenta no tiene permiso para acceder a esta sección. Si crees que es un error, contacta con la asociación.' : error}</p><div className="pv-actions">{status === 401 ? <Link className="pv-btn pv-btn--primary" to="/acceso">Ir a iniciar sesión <ArrowRight size={17} /></Link> : status === 403 ? <Link className="pv-btn pv-btn--primary" to="/contacto">Contactar</Link> : <button className="pv-btn pv-btn--primary" onClick={retry}>Volver a intentarlo</button>}<Link className="pv-btn pv-btn--secondary" to="/">Ir al inicio</Link></div></div></div>;
}
function Heading({ eyebrow, title, description, aside }: { eyebrow: string; title: ReactNode; description: string; aside?: ReactNode }) { return <div className="pv-heading"><div><div className="pv-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{aside}</div>; }

export default function MemberArea() {
  const location = useLocation();
  const [user, setUser] = useState<Entity | null>(null);
  const [summary, setSummary] = useState<Entity | null>(null);
  const [events, setEvents] = useState<Entity[]>([]);
  const [eventsError, setEventsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<{ status: number; message: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [memberName, setMemberName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [profile, setProfile] = useState({ name: '', email: '', phone: '', address: '' });
  const [consent, setConsent] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, { memberQty: number; guestQty: number }>>({});

  const handleError = useCallback((error: unknown) => {
    const err = error instanceof Error ? error : new Error('Se ha producido un error inesperado.');
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setGate({ status: error.status, message: err.message });
    else setMessage({ kind: 'error', text: err.message });
  }, []);
  const load = useCallback(async () => {
    setLoading(true); setGate(null); setEventsError('');
    try {
      const auth = await api('/api/auth/me');
      if (!auth.user) throw new ApiError('Inicia sesión para continuar.', 401);
      const result = await api('/api/member/summary');
      if (!result.family || !Array.isArray(result.members) || !Array.isArray(result.charges) || !Array.isArray(result.payments)) throw new ApiError('Los datos de la vivienda están incompletos. Inténtalo de nuevo.', 0);
      setUser(auth.user); setSummary(result);
      setProfile({ name: String(value(auth.user, 'name') || ''), email: String(value(auth.user, 'email') || ''), phone: String(value(result.family, 'phone') || ''), address: String(value(result.family, 'address') || '') });
      try { const eventResult = await api('/api/member/events'); if (!Array.isArray(eventResult.events)) throw new ApiError('La respuesta de eventos está incompleta.', 0); setEvents(eventResult.events); }
      catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw e; setEventsError(e instanceof Error ? e.message : 'No se han podido cargar los eventos.'); }
    } catch (e) { const err = e instanceof Error ? e : new Error('No se ha podido cargar el área de socios.'); setGate({ status: e instanceof ApiError ? e.status : 0, message: err.message }); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setMessage(null); }, [location.pathname]);
  const refreshSummary = async () => { try { const data = await api('/api/member/summary'); if (!data.family || !Array.isArray(data.members) || !Array.isArray(data.charges) || !Array.isArray(data.payments)) throw new Error('Respuesta incompleta'); setSummary(data); } catch (e) { if (e instanceof ApiError && [401, 403].includes(e.status)) throw e; throw new Error('La operación se ha realizado, pero no se han podido actualizar los datos. Recarga antes de repetirla.'); } };
  const refreshEvents = async () => { const data = await api('/api/member/events'); if (!Array.isArray(data.events)) throw new Error('La respuesta de eventos está incompleta.'); setEvents(data.events); setEventsError(''); };
  const run = async (key: string, action: () => Promise<void>, success?: string) => {
    setBusy(key); setMessage(null);
    try { await action(); if (success) setMessage({ kind: 'success', text: success }); }
    catch (e) { handleError(e); }
    finally { setBusy(''); }
  };
  const family: Entity = summary?.family || {};
  const members: Entity[] = Array.isArray(summary?.members) ? summary!.members : [];
  const charges: Entity[] = Array.isArray(summary?.charges) ? summary!.charges : [];
  const payments: Entity[] = Array.isArray(summary?.payments) ? summary!.payments : [];
  const historicalStanding: Entity[] = Array.isArray(summary?.historicalStanding) ? summary!.historicalStanding : [];
  const showHistorical2025 = historicalStanding.some(entry => Number(entry.year) === 2025 && entry.status === 'current') && !charges.some(charge => Number(charge.year) === 2025);
  const pendingCharges = charges.filter(c => c.status === 'pending');
  const currentYear = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric' }).format(new Date()));
  const missingCurrentAnnual = family.status === 'active' && currentYear >= 2027 && !charges.some(charge => Number(charge.year) === currentYear && charge.kind === 'annual');
  const overall = missingCurrentAnnual ? (pendingCharges.length ? 'Cargos pendientes · cuota anual pendiente de comprobar' : 'Pendiente de comprobar') : pendingCharges.length ? 'Tienes cargos pendientes' : charges.length === 0 ? 'Sin cargos registrados' : charges.every(c => ['paid', 'exempt'].includes(c.status)) ? 'Al corriente según tus cargos' : 'Consulta tus cargos';
  const path = location.pathname.replace(/\/$/, '') || '/socios';
  const nextEvent = useMemo(() => events.find(event => !eventHasPassed(value(event, 'startsAt', 'starts_at'))), [events]);
  const logout = () => void run('logout', async () => { await api('/api/auth/logout', send('POST')); setGate({ status: 401, message: '' }); });
  if (loading) return <div className="pv-loading" role="status"><LoaderCircle className="pv-spin" size={27} /><span>Preparando tu espacio…</span></div>;
  if (gate || !user) return <Gate status={gate?.status || 0} error={gate?.message || 'No se ha podido cargar tu espacio.'} retry={load} />;

  const addMember = (e: FormEvent) => { e.preventDefault(); void run('add-member', async () => { await api('/api/member/members', send('POST', { name: memberName.trim(), relationship: relationship.trim() })); setMemberName(''); setRelationship(''); await refreshSummary(); }, 'Persona añadida a tu unidad familiar.'); };
  const saveProfile = (e: FormEvent) => { e.preventDefault(); void run('profile', async () => { await api('/api/member/profile', send('PUT', profile)); setUser({ ...user, name: profile.name, email: profile.email }); await refreshSummary(); }, 'Tus datos se han actualizado.'); };

  return <Shell user={user} onLogout={logout}>
    {message && <Notice kind={message.kind}>{message.text}</Notice>}
    {new URLSearchParams(location.search).get('checkout') === 'return' && <Notice>Volver de Stripe no confirma el pago. El estado se actualizará cuando se reciba la notificación verificada; si sigue pendiente, consulta con la asociación.</Notice>}
    {new URLSearchParams(location.search).get('checkout') === 'cancel' && <Notice>Has vuelto sin completar el proceso de pago. Comprueba el estado antes de intentarlo de nuevo.</Notice>}
    {path === '/socios' && <>
      <Heading eyebrow="TU COMUNIDAD, MÁS CERCA" title={<>Hola, {String(user.name || 'vecino').split(' ')[0]}<span className="pv-heading-accent">.</span></>} description="Este es tu espacio en Vega de San Juan. Todo lo importante de tu vivienda, en un mismo lugar." aside={<div className="pv-date-chip"><CalendarDays size={17} /> {new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}</div>} />
      <div className="pv-hero"><div><div className="pv-hero-label"><span /> TU HOGAR EN LA ASOCIACIÓN</div><h2>Un barrio mejor<br />se construye juntos.</h2><p>Desde aquí puedes gestionar tu familia y mantenerte al día de todo lo que compartimos.</p><Link className="pv-btn pv-btn--light" to="/socios/familia">Ver mi familia <ArrowRight size={17} /></Link></div><div className="pv-hero-art" aria-hidden="true"><div className="pv-hero-ring pv-hero-ring--one" /><div className="pv-hero-ring pv-hero-ring--two" /><div className="pv-hero-house"><Home size={66} strokeWidth={1.1} /></div></div></div>
      <div className="pv-metrics"><div className="pv-metric"><div className="pv-metric-icon pv-icon-blue"><Home size={20} /></div><div><span>ESTADO DE LA VIVIENDA</span><strong>{statusText(family.status)}</strong><small>{family.status === 'pending' ? 'Pendiente de aprobación' : family.address || 'Tu unidad familiar'}</small></div></div><div className="pv-metric"><div className="pv-metric-icon pv-icon-green"><Users size={20} /></div><div><span>UNIDAD FAMILIAR</span><strong>{members.length} {members.length === 1 ? 'persona' : 'personas'}</strong><small>Miembros registrados</small></div></div><div className="pv-metric"><div className="pv-metric-icon pv-icon-peach"><WalletCards size={20} /></div><div><span>CUOTAS</span><strong>{overall}</strong><small>Cuota familiar: 20 €/año</small></div></div></div>
      {family.status === 'pending' && <Notice>Tu alta está pendiente de aprobación. Podrás adquirir entradas cuando tu familia esté activa.</Notice>}
      <div className="pv-grid pv-grid--two"><section className="pv-card"><div className="pv-card-head"><div><div className="pv-overline">TU VIVIENDA</div><h2>Tu familia</h2></div><Link className="pv-text-link" to="/socios/familia">Gestionar <ArrowRight size={16} /></Link></div>{members.length ? <div className="pv-people">{members.slice(0, 4).map(m => <div className="pv-person" key={m.id}><span className="pv-person-avatar">{initials(m.name)}</span><span><strong>{m.name}</strong><small>{m.relationship || 'Miembro de la unidad familiar'}</small></span></div>)}</div> : <Empty icon={<Users size={23} />} title="Tu familia, aquí">Aún no hay miembros registrados.</Empty>}</section>
      <section className="pv-card"><div className="pv-card-head"><div><div className="pv-overline">NOS VEMOS PRONTO</div><h2>Próximo evento</h2></div><Link className="pv-text-link" to="/socios/eventos">Ver todos <ArrowRight size={16} /></Link></div>{eventsError ? <Notice kind="error">{eventsError}</Notice> : nextEvent ? <div className="pv-upcoming"><div className="pv-upcoming-icon"><CalendarDays size={25} /></div><div><strong>{nextEvent.title}</strong><p>{date(value(nextEvent, 'startsAt', 'starts_at'), true)}</p>{nextEvent.location && <small><MapPin size={14} /> {nextEvent.location}</small>}</div></div> : <Empty icon={<CalendarDays size={23} />} title="Sin próximos eventos">Cuando haya novedades, las encontrarás aquí.</Empty>}</section></div>
    </>}
    {path === '/socios/familia' && <><Heading eyebrow="TU VIVIENDA" title="Mi familia" description="Las personas que forman parte de tu unidad familiar, reunidas en un solo lugar." /><div className="pv-section-intro"><div><Badge tone={statusTone(family.status)}>{statusText(family.status)}</Badge><p>{family.address || 'Dirección no indicada'}</p></div><span className="pv-count"><Users size={17} /> {members.length} {members.length === 1 ? 'miembro' : 'miembros'}</span></div><div className="pv-grid pv-grid--two-thirds"><section className="pv-card"><div className="pv-card-head"><div><div className="pv-overline">PERSONAS REGISTRADAS</div><h2>Unidad familiar</h2></div></div>{members.length ? <div className="pv-list">{members.map(m => <div className="pv-list-row" key={m.id}><div className="pv-row-primary"><span className="pv-person-avatar">{initials(m.name)}</span><span><strong>{m.name}</strong><small>{m.relationship || 'Miembro de la unidad familiar'}</small></span></div><button type="button" className="pv-icon-button pv-danger-icon" aria-label={`Eliminar a ${m.name}`} title={m.relationship === 'Titular' ? 'No se puede eliminar al titular' : 'Eliminar miembro'} disabled={!!busy || m.relationship === 'Titular'} onClick={() => { if (window.confirm(`¿Eliminar a ${m.name} de la unidad familiar?`)) void run(`delete-${m.id}`, async () => { await api(`/api/member/members/${m.id}`, send('DELETE')); await refreshSummary(); }, 'Miembro eliminado.'); }}><Trash2 size={18} /></button></div>)}</div> : <Empty icon={<Users size={24} />} title="Todavía no hay miembros">Añade las personas de tu unidad familiar desde el formulario.</Empty>}</section><section className="pv-card"><div className="pv-overline">SUMAR A ALGUIEN</div><h2>Añadir miembro</h2><p className="pv-card-copy">Las personas registradas determinan el límite de entradas familiares de los eventos.</p><form className="pv-form" onSubmit={addMember}><label>Nombre completo<input value={memberName} onChange={e => setMemberName(e.target.value)} maxLength={160} required placeholder="Nombre y apellidos" /></label><label><span>Relación <span className="pv-optional">(opcional)</span></span><input value={relationship} onChange={e => setRelationship(e.target.value)} maxLength={80} placeholder="Por ejemplo, hijo o pareja" /></label><button className="pv-btn pv-btn--primary pv-btn--full" disabled={!!busy}><Plus size={17} /> {busy === 'add-member' ? 'Añadiendo…' : 'Añadir a mi familia'}</button></form></section></div></>}
    {path === '/socios/perfil' && <><Heading eyebrow="TUS DATOS" title="Mi perfil" description="Mantén actualizados tus datos de contacto y los de tu vivienda." /><div className="pv-grid pv-grid--two-thirds"><section className="pv-card"><div className="pv-overline">INFORMACIÓN DE CONTACTO</div><h2>Datos personales</h2><p className="pv-card-copy">Utilizaremos estos datos para mantenernos en contacto contigo.</p><form className="pv-form" onSubmit={saveProfile}><div className="pv-form-grid"><label>Nombre completo<input required maxLength={160} value={profile.name} onChange={e => setProfile({ ...profile, name: e.target.value })} /></label><label>Correo electrónico<input required type="email" maxLength={255} value={profile.email} onChange={e => setProfile({ ...profile, email: e.target.value })} /></label><label>Teléfono<input type="tel" maxLength={40} value={profile.phone} onChange={e => setProfile({ ...profile, phone: e.target.value })} /></label><label>Dirección de la vivienda<input required maxLength={255} value={profile.address} onChange={e => setProfile({ ...profile, address: e.target.value })} /></label></div><button className="pv-btn pv-btn--primary" disabled={!!busy}>{busy === 'profile' ? 'Guardando…' : 'Guardar cambios'} <ArrowRight size={17} /></button></form></section><aside className="pv-card pv-help-card"><div className="pv-metric-icon pv-icon-blue"><Mail size={21} /></div><h2>¿Necesitas ayuda?</h2><p>Si necesitas modificar otros datos o tienes alguna duda, estamos aquí para ayudarte.</p><Link className="pv-text-link" to="/contacto">Contactar con la asociación <ArrowRight size={16} /></Link></aside></div></>}
    {path === '/socios/cuotas' && <><Heading eyebrow="TU CONTRIBUCIÓN" title="Cuotas y pagos" description="Consulta tus cargos y el historial de pagos de tu vivienda." /><div className="pv-fee-banner"><div><div className="pv-overline">CUOTA DE LA ASOCIACIÓN</div><strong>20 € <span>/ año por vivienda</span></strong><p>2026 es un año exento. La primera cuota anual para nuevas altas corresponde a 2027 y se genera desde el 1 de enero.</p></div><Badge tone={pendingCharges.length || missingCurrentAnnual ? 'warn' : 'neutral'}>{overall}</Badge></div><div className="pv-grid pv-grid--two-thirds"><div className="pv-stack"><section className="pv-card"><div className="pv-card-head"><div><div className="pv-overline">DETALLE DE LA VIVIENDA</div><h2>Cuotas y cargos</h2></div></div>{charges.length || showHistorical2025 ? <div className="pv-list">{charges.map(c => <div className="pv-list-row pv-charge-row" key={c.id}><div><strong>{c.description || (c.year ? `Cuota ${c.year}` : 'Cargo')}</strong><small>{value(c, 'dueDate', 'due_date') ? `Vencimiento: ${date(value(c, 'dueDate', 'due_date'))}` : 'Sin fecha indicada'}</small><Badge tone={statusTone(c.status)}>{statusText(c.status)}</Badge></div><div className="pv-row-end"><strong>{money(value(c, 'amountCents', 'amount_cents'))}</strong>{c.status === 'pending' && <button className="pv-text-link pv-link-button" disabled={!!busy || family.status !== 'active'} onClick={() => void run(`charge-${c.id}`, async () => { const result = await api(`/api/member/charges/${c.id}/checkout`, send('POST')); safeCheckout(result.url); })}>{busy === `charge-${c.id}` ? 'Conectando…' : 'Pagar con tarjeta'} <ArrowRight size={15} /></button>}</div></div>)}{showHistorical2025 && <div className="pv-list-row pv-charge-row"><div><strong>2025 · Al corriente (importe no registrado)</strong></div></div>}</div> : <Empty icon={<WalletCards size={24} />} title="Sin cargos registrados">Cuando haya cuotas o cargos para tu vivienda aparecerán aquí.</Empty>}{family.status !== 'active' && pendingCharges.length > 0 && <p className="pv-note">El pago en línea requiere una familia activa.</p>}</section><section className="pv-card"><div className="pv-overline">MOVIMIENTOS</div><h2>Historial de pagos</h2>{payments.length ? <div className="pv-list">{payments.map(p => <div className="pv-list-row" key={p.id}><div><strong>{p.provider === 'stripe' ? 'Pago con Stripe' : p.provider === 'manual' ? 'Pago manual' : 'Pago'}</strong><small>{value(p, 'paidAt', 'paid_at') ? date(value(p, 'paidAt', 'paid_at')) : 'Fecha de pago no registrada'}{p.reference ? ` · Ref. ${p.reference}` : ''}</small></div><div className="pv-row-end"><strong>{money(value(p, 'amountCents', 'amount_cents'))}</strong><Badge tone={statusTone(p.status)}>{statusText(p.status)}</Badge></div></div>)}</div> : <Empty icon={<CreditCard size={24} />} title="Sin pagos registrados">Tus pagos confirmados aparecerán en este apartado.</Empty>}</section></div><aside className="pv-card pv-payment-card"><div className="pv-metric-icon pv-icon-green"><CreditCard size={21} /></div><div className="pv-overline">FORMA DE PAGO</div><h2>Elige cómo contribuir</h2><p className="pv-card-copy">Método registrado: <strong>{family.payment_method === 'card' || family.paymentMethod === 'card' ? 'tarjeta' : family.payment_method === 'manual' || family.paymentMethod === 'manual' ? 'manual' : 'no disponible'}</strong>.</p><div className="pv-payment-choice"><strong>Pago manual</strong><p>Para pagar por transferencia o solicitar el cambio a pago manual, contacta con la asociación. El pago se reflejará cuando administración lo registre.</p><Link className="pv-text-link" to="/contacto">Contactar <ArrowRight size={15} /></Link></div><div className="pv-payment-choice"><strong>Configurar tarjeta</strong><p>El cobro automático todavía no está disponible. No se registrará ninguna tarjeta ni se activarán cobros recurrentes hasta completar su validación.</p><label className="pv-checkbox"><input type="checkbox" disabled checked={consent} onChange={e => setConsent(e.target.checked)} /><span>Autorizo la configuración de mi tarjeta en Stripe para futuros cobros de la asociación.</span></label><button className="pv-btn pv-btn--secondary pv-btn--full" disabled={true} onClick={() => { if (!consent) return; void run('setup', async () => { const result = await api('/api/member/card/setup', send('POST', { consent: true })); safeCheckout(result.url); }); }}>No disponible todavía <ExternalLink size={15} /></button>{family.status !== 'active' && <small>Requiere una familia activa.</small>}</div></aside></div></>}
    {path === '/socios/eventos' && <><Heading eyebrow="VIDA DE BARRIO" title="Eventos y encuentros" description="Buenos momentos para compartir, conocer a tus vecinos y hacer comunidad." />{eventsError ? <Notice kind="error">{eventsError} <button className="pv-link-button" onClick={() => void run('refresh-events', refreshEvents)}>Reintentar</button></Notice> : events.length ? <div className="pv-event-grid">{events.map(event => {
      const id = String(event.id); const attending = typeof event.rsvp === 'object' && event.rsvp !== null ? flag(event.rsvp.attending) : flag(event.rsvp);
      const enabled = flag(value(event, 'ticketsEnabled', 'tickets_enabled')); const confirmed = flag(value(event, 'priceConfirmed', 'price_confirmed'));
      const starts = value(event, 'startsAt', 'starts_at'); const isPast = eventHasPassed(starts);
      const limitRaw = value(event, 'memberLimit', 'member_limit'); const bookedRaw = value(event, 'memberBooked', 'member_booked');
      const limit = limitRaw === undefined ? null : Number(limitRaw); const booked = bookedRaw === undefined ? null : Number(bookedRaw); const remaining = limit !== null && booked !== null && Number.isFinite(limit) && Number.isFinite(booked) ? Math.max(0, limit - booked) : null;
      const qty = quantities[id] || { memberQty: 0, guestQty: 0 }; const memberPrice = value(event, 'memberPriceCents', 'member_price_cents'); const guestPrice = value(event, 'guestPriceCents', 'guest_price_cents');
      const subtotal = memberPrice !== undefined && guestPrice !== undefined && Number.isFinite(Number(memberPrice)) && Number.isFinite(Number(guestPrice)) ? qty.memberQty * Number(memberPrice) + qty.guestQty * Number(guestPrice) : null;
      return <article className="pv-card pv-event-card" key={id}><div className="pv-event-top"><div className="pv-event-icon"><CalendarDays size={23} /></div><Badge tone={attending ? 'good' : 'neutral'}>{attending ? 'Asistencia confirmada' : 'Evento'}</Badge></div><h2>{event.title}</h2><div className="pv-event-meta"><span><CalendarDays size={16} /> {date(value(event, 'startsAt', 'starts_at'), true)}</span>{event.location && <span><MapPin size={16} /> {event.location}</span>}</div>{event.description && <p className="pv-event-description">{event.description}</p>}<button className={`pv-btn ${attending ? 'pv-btn--secondary' : 'pv-btn--primary'}`} disabled={!!busy || family.status !== 'active' || isPast} onClick={() => void run(`rsvp-${id}`, async () => { await api(`/api/member/events/${id}/rsvp`, send('POST', { attending: !attending })); await refreshEvents(); }, attending ? 'Tu asistencia se ha cancelado.' : 'Tu asistencia se ha confirmado.')}>{attending ? <><Check size={16} /> Cancelar asistencia</> : <>Voy a asistir <ArrowRight size={16} /></>}</button>
      {(family.status !== 'active' || isPast) && <p className="pv-note">{isPast ? 'Este evento ya ha comenzado.' : 'Para confirmar la asistencia se requiere una familia activa.'}</p>}
      {enabled && <div className="pv-ticket-box"><div className="pv-ticket-title"><Ticket size={19} /><strong>Entradas</strong></div>{!confirmed && <Notice>El precio está pendiente de confirmación. La compra aún no está disponible.</Notice>}<div className="pv-price-line"><span>Familiar <strong>{money(memberPrice)}</strong></span><span>Invitado <strong>{money(guestPrice)}</strong></span></div><p className="pv-note">{remaining === null ? 'No se ha podido determinar el límite familiar disponible.' : `Límite familiar: ${limit}. Ya reservadas o compradas: ${booked}. Disponibles: ${remaining}.`} Las entradas de invitados no tienen límite propio, salvo aforo.</p><div className="pv-quantity-grid"><label>Familiares<input type="number" min="0" max={remaining ?? 0} step="1" value={qty.memberQty} onChange={e => setQuantities({ ...quantities, [id]: { ...qty, memberQty: Math.max(0, Number(e.target.value) || 0) } })} /></label><label>Invitados<input type="number" min="0" step="1" value={qty.guestQty} onChange={e => setQuantities({ ...quantities, [id]: { ...qty, guestQty: Math.max(0, Number(e.target.value) || 0) } })} /></label></div><div className="pv-total"><span>Total orientativo</span><strong>{money(subtotal)}</strong></div><button className="pv-btn pv-btn--primary pv-btn--full" disabled={!!busy || family.status !== 'active' || isPast || !confirmed || remaining === null || qty.memberQty > remaining || !Number.isInteger(qty.memberQty) || !Number.isInteger(qty.guestQty) || qty.memberQty + qty.guestQty === 0 || subtotal === null} onClick={() => void run(`checkout-${id}`, async () => { const result = await api(`/api/member/events/${id}/checkout`, send('POST', qty)); safeCheckout(result.url); })}>{busy === `checkout-${id}` ? 'Conectando…' : 'Continuar al pago'} <ArrowRight size={16} /></button>{family.status !== 'active' && <p className="pv-note">La compra requiere una familia activa.</p>}<p className="pv-note">El importe y la disponibilidad se verifican en el servidor. El pago solo se confirma tras la notificación de Stripe.</p></div>}</article>;
    })}</div> : <div className="pv-card"><Empty icon={<CalendarDays size={27} />} title="Todavía no hay eventos">Cuando la asociación publique un encuentro, aparecerá aquí.</Empty></div>}</>}
    {!['/socios', '/socios/familia', '/socios/cuotas', '/socios/eventos', '/socios/perfil'].includes(path) && <div className="pv-card"><Empty icon={<Home size={25} />} title="No encontramos esta sección"><Link className="pv-text-link" to="/socios">Volver al resumen <ArrowRight size={16} /></Link></Empty></div>}
  </Shell>;
}
