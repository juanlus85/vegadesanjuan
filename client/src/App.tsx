import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUpRight, CalendarDays, HeartHandshake, MapPin, Menu, MessageCircle, Plus, ShieldCheck, UsersRound, X } from 'lucide-react';
import MemberArea from './components/MemberArea';
import AdminArea from './components/AdminArea';

const fallbackContactEmail = 'avvvegadesanjuan@gmail.com';
const ContactEmailContext = createContext(fallbackContactEmail);
const contactMailto = (email: string) => `mailto:${encodeURIComponent(email).replace(/%40/i, '@')}`;

const neighbourhoods = [
  'Real de Valdomina', 'Valparaíso', 'Valparaíso Hills', 'Residencial Europa',
  'Jardines de Europa', 'Pórtico de Simón Verde', 'Vía Célere San Juan',
];

type ApiResult = { ok?: boolean; error?: string; message?: string; [key: string]: unknown };

async function request(path: string, options: RequestInit = {}): Promise<ApiResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new Error('No hemos podido conectar. Comprueba tu conexión e inténtalo de nuevo.');
  }
  let data: ApiResult;
  try {
    data = await response.json() as ApiResult;
  } catch {
    throw new Error('La respuesta del servidor no es válida. Inténtalo de nuevo más tarde.');
  }
  if (!response.ok || data.ok !== true) {
    const fallback = response.status === 401 ? 'Tu sesión ha caducado o los datos de acceso no son correctos.'
      : response.status === 403 ? 'No tienes permiso para realizar esta acción.'
        : 'No se ha podido completar la solicitud. Inténtalo de nuevo.';
    throw new Error(typeof data.error === 'string' ? data.error : fallback);
  }
  return data;
}

function RouteEffects() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Vega de San Juan | Asociación de Vecinos',
      '/asociacion': 'Nuestra asociación | Vega de San Juan',
      '/contacto': 'Contacto | Vega de San Juan',
      '/alta': 'Hazte socio | Vega de San Juan',
      '/acceso': 'Acceso socios | Vega de San Juan',
    };
    document.title = titles[pathname] || (pathname.startsWith('/admin') ? 'Administración | Vega de San Juan' : pathname.startsWith('/socios') ? 'Área de socios | Vega de San Juan' : 'Página no encontrada | Vega de San Juan');
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', pathname.startsWith('/socios') || pathname.startsWith('/admin') || pathname === '/acceso' || !titles[pathname] ? 'noindex, nofollow' : 'index, follow');
    if (hash) {
      const id = decodeURIComponent(hash.slice(1));
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }));
    } else {
      window.scrollTo(0, 0);
    }
  }, [pathname, hash]);
  return null;
}

function Logo({ footer = false }: { footer?: boolean }) {
  return <Link className={footer ? 'brand brand-footer' : 'brand'} to="/" aria-label="Vega de San Juan, ir al inicio"><img src={footer ? '/assets/logo-original.png' : '/assets/logo-web.png'} alt="Asociación de Vecinos Vega de San Juan" /></Link>;
}

function Header() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname, location.hash]);
  return <header className="site-header">
    <div className="header-inner wrap">
      <Logo />
      <button className="menu-toggle" type="button" aria-expanded={open} aria-controls="primary-navigation" aria-label={open ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setOpen(!open)}>{open ? <X size={24} /> : <Menu size={24} />}</button>
      <nav id="primary-navigation" className={`main-nav ${open ? 'is-open' : ''}`} aria-label="Navegación principal">
        <Link to="/asociacion">La asociación</Link>
        <Link to="/#barrios">Nuestro barrio</Link>
        <Link to="/#actividades">Actividades</Link>
        <Link to="/contacto">Contacto</Link>
        <Link className="nav-login" to="/acceso">Acceso socios <ArrowUpRight size={15} /></Link>
        <Link className="button button-green nav-join" to="/alta">Hazte socio <ArrowRight size={17} /></Link>
      </nav>
    </div>
  </header>;
}

function BuildInfo() {
  if (typeof __BUILD_INFO__ === 'undefined' || !__BUILD_INFO__) return null;
  const { version, builtAt } = __BUILD_INFO__;
  let date = '';
  if (builtAt && !Number.isNaN(new Date(builtAt).getTime())) {
    date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(builtAt));
  }
  return <span className="build-info">{version ? `Versión ${version}` : ''}{date ? ` · ${date}` : ''}</span>;
}

function Footer() {
  const contactEmail = useContext(ContactEmailContext);
  return <footer className="footer">
    <div className="wrap footer-main">
      <div className="footer-about"><div className="footer-logo"><Logo footer /></div><p>Vecinas y vecinos construyendo, cada día, un barrio más unido.</p><span>San Juan de Aznalfarache · Sevilla</span></div>
      <div className="footer-column"><h3>Descubre</h3><Link to="/asociacion">La asociación</Link><Link to="/#barrios">Nuestro barrio</Link><Link to="/#actividades">Actividades</Link><Link to="/alta">Hazte socio</Link></div>
      <div className="footer-column"><h3>Hablemos</h3><Link to="/contacto">Contacto</Link><a href={contactMailto(contactEmail)}>{contactEmail}</a><Link to="/acceso">Acceso socios</Link></div>
      <div className="footer-column"><h3>Síguenos</h3><a href="https://www.instagram.com/avvvegadesanjuan/" target="_blank" rel="noopener noreferrer">Instagram <ArrowUpRight size={14} /></a><a href="https://www.facebook.com/vegadesanjuan/" target="_blank" rel="noopener noreferrer">Facebook <ArrowUpRight size={14} /></a></div>
    </div>
    <div className="wrap footer-bottom"><span>© {new Date().getFullYear()} Asociación de Vecinos Vega de San Juan. Todos los derechos reservados.</span><BuildInfo /></div>
  </footer>;
}

function PublicLayout({ children }: { children: ReactNode }) {
  return <><a className="skip-link" href="#contenido">Saltar al contenido</a><Header /><main id="contenido">{children}</main><Footer /></>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="eyebrow"><span className="label-mark" aria-hidden="true" />{children}</p>;
}

function EventList() {
  type Event = { id?: number; title?: string; startsAt?: string; starts_at?: string; location?: string };
  const [status, setStatus] = useState<'loading' | 'error' | 'loaded'>('loading');
  const [events, setEvents] = useState<Event[]>([]);
  useEffect(() => {
    let mounted = true;
    request('/api/public/config').then(data => {
      if (mounted) { setEvents(Array.isArray(data.upcomingEvents) ? data.upcomingEvents as Event[] : []); setStatus('loaded'); }
    }).catch(() => { if (mounted) setStatus('error'); });
    return () => { mounted = false; };
  }, []);
  const dateLabel = (value?: string) => {
    if (!value) return 'Fecha pendiente de confirmar';
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!parts) return 'Fecha pendiente de confirmar';
    return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))));
  };
  return <div className="agenda" aria-live="polite">
    <div className="agenda-heading"><span><CalendarDays size={19} /> Agenda vecinal</span><Link to="/acceso">Área de socios <ArrowUpRight size={16} /></Link></div>
    {status === 'loading' && <p>Cargando próximas actividades…</p>}
    {status === 'error' && <p>La agenda no está disponible en este momento. Puedes consultarnos para saber más.</p>}
    {status === 'loaded' && events.length === 0 && <p>Aún no hay próximas actividades publicadas. ¡Vuelve pronto!</p>}
    {status === 'loaded' && events.slice(0, 3).map((event, index) => <div className="event-row" key={event.id ?? index}><div><strong>{event.title || 'Actividad de la asociación'}</strong><span>{dateLabel(event.startsAt || event.starts_at)}{event.location ? ` · ${event.location}` : ''}</span></div><ArrowUpRight size={18} aria-hidden="true" /></div>)}
  </div>;
}

function Home() {
  return <PublicLayout>
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-image" aria-hidden="true" />
      <div className="wrap hero-content"><div className="hero-copy">
        <p className="hero-kicker"><span /> SAN JUAN DE AZNALFARACHE · SEVILLA</p>
        <h1 id="hero-title">Una zona{' '}<br />que <em>nos une.</em></h1>
        <p className="hero-intro">Las buenas cosas pasan cuando nos conocemos, nos cuidamos y caminamos juntos.</p>
        <div className="hero-actions"><Link className="button button-light" to="/alta">Quiero formar parte <ArrowRight size={18} /></Link><Link className="text-link light-link" to="/asociacion">Conoce la asociación <ArrowUpRight size={17} /></Link></div>
      </div><div className="hero-caption"><span>ASOCIACIÓN DE VECINOS</span><strong>Vega de San Juan</strong><small>Juntos, desde 2011</small></div></div>
      <a className="hero-scroll" href="#bienvenida" aria-label="Descubrir la asociación"><ArrowDown size={19} /></a>
    </section>
    <div className="ribbon"><div className="wrap ribbon-inner"><span>DE AQUÍ, PARA TODOS</span><span className="ribbon-rule" /><p>Un lugar se convierte en barrio cuando lo compartimos.</p><span className="ribbon-symbol">✳</span></div></div>
    <section className="intro-section section-pad" id="bienvenida"><div className="wrap intro-grid">
      <div><SectionLabel>HOLA, VECINDAD</SectionLabel><h2>La vida es mejor<br /><em>cuando es en común.</em></h2></div>
      <div className="intro-body"><p className="lead">Somos personas que creemos en el poder de un barrio unido.</p><p>Desde abril de 2011, trabajamos por el bienestar de nuestro entorno en San Juan de Aznalfarache. Escuchamos, proponemos y compartimos lo que nos importa: un barrio en el que vivir mejor.</p><Link className="underlined-link" to="/asociacion">Conoce nuestra historia <ArrowUpRight size={18} /></Link></div>
    </div></section>
    <section className="values-section"><div className="wrap value-grid">
      <article className="value-card"><span className="value-icon"><MessageCircle /></span><span className="value-number">01 / ESCUCHAR</span><h3>Tu voz importa.</h3><p>Defendemos los intereses del vecindario y trabajamos juntos por nuestro entorno.</p></article>
      <article className="value-card"><span className="value-icon"><UsersRound /></span><span className="value-number">02 / COMPARTIR</span><h3>Encontrarnos suma.</h3><p>Promovemos actividades familiares que nos acercan y llenan de vida el barrio.</p></article>
      <article className="value-card"><span className="value-icon"><HeartHandshake /></span><span className="value-number">03 / CUIDARNOS</span><h3>Siempre cerca.</h3><p>Colaboramos de forma solidaria, porque una comunidad fuerte cuida de las personas.</p></article>
    </div></section>
    <section className="neighbourhood-section section-pad" id="barrios"><div className="wrap neighbourhood-grid"><div><SectionLabel>NUESTRO ENTORNO</SectionLabel><h2>Distintas calles.<br /><em>Un mismo barrio.</em></h2><p className="lead">Compartimos mucho más que un lugar en el mapa.</p><p>La asociación reúne a vecinas y vecinos de estas urbanizaciones de San Juan de Aznalfarache:</p><Link className="underlined-link" to="/contacto">Ponte en contacto <ArrowUpRight size={18} /></Link></div><div className="neighbourhood-list"><div className="list-top"><MapPin size={20} /><span>VEGA DE SAN JUAN</span><span>SEVILLA</span></div>{neighbourhoods.map((name, index) => <div className="neighbourhood-item" key={name}><span>{String(index + 1).padStart(2, '0')}</span><strong>{name}</strong><ArrowUpRight size={17} /></div>)}</div></div></section>
    <section className="activities-section section-pad" id="actividades"><div className="wrap activities-grid"><div><SectionLabel>LA VIDA DEL BARRIO</SectionLabel><h2>Siempre hay algo<br /><em>que nos acerca.</em></h2><p>Momentos para encontrarnos, disfrutar en familia y hacer comunidad. Porque el barrio también se vive juntos.</p><Link className="underlined-link" to="/contacto">¿Tienes una idea? Cuéntanosla <ArrowUpRight size={18} /></Link></div><EventList /></div></section>
    <section className="join-section"><div className="wrap join-inner"><div><SectionLabel>HAZTE DE AQUÍ</SectionLabel><h2>Tu casa también<br /><em>forma parte.</em></h2><p>Una asociación la hacemos entre todas las personas que la forman. Súmate y ayudemos a que nuestro barrio siga creciendo.</p><Link className="button button-light" to="/alta">Hazte socio <ArrowRight size={18} /></Link></div><div className="fee-card"><span>CUOTA POR VIVIENDA</span><div className="fee-price">20 <span>€</span></div><p>al año / por unidad familiar</p><div className="fee-line" /><small>2026 está exento. La cuota anual se aplica desde el 1 de enero de 2027. El alta no realiza ningún cobro.</small></div></div></section>
    <section className="bottom-cta"><div className="wrap bottom-inner"><div><SectionLabel>ESTAMOS CERCA</SectionLabel><h2>¿Hablamos, vecino?</h2><p>Una pregunta, una propuesta o simplemente un hola. Estamos aquí.</p></div><Link className="round-arrow" to="/contacto" aria-label="Ir a contacto"><ArrowUpRight size={30} /></Link></div></section>
  </PublicLayout>;
}

function Association() {
  return <PublicLayout><section className="inner-hero"><div className="wrap"><SectionLabel>NUESTRA ASOCIACIÓN</SectionLabel><h1>Unidos por el lugar<br /><em>que llamamos hogar.</em></h1><p>Somos Vega de San Juan. Un grupo de vecinas y vecinos que comparte una forma de entender el barrio: participativa, cercana y solidaria.</p></div></section><section className="section-pad"><div className="wrap story-grid"><div><SectionLabel>DESDE ABRIL DE 2011</SectionLabel><h2>El barrio lo hacemos<br /><em>entre todos.</em></h2></div><div className="story-copy"><p className="lead">La asociación nació para dar voz a nuestro entorno en San Juan de Aznalfarache, Sevilla.</p><p>Desde entonces, unimos esfuerzos para defender los intereses vecinales, fomentar la convivencia y colaborar en iniciativas solidarias. También creamos espacios para encontrarnos y compartir actividades en familia.</p><p>Estamos presentes en Real de Valdomina, Valparaíso, Valparaíso Hills, Residencial Europa, Jardines de Europa, Pórtico de Simón Verde y Vía Célere San Juan.</p><Link className="underlined-link" to="/alta">Descubre cómo formar parte <ArrowUpRight size={18} /></Link></div></div></section><section className="values-section"><div className="wrap value-grid"><article className="value-card"><span className="value-icon"><MessageCircle /></span><h3>Defensa vecinal</h3><p>Escuchamos las necesidades compartidas y trabajamos por nuestro entorno.</p></article><article className="value-card"><span className="value-icon"><UsersRound /></span><h3>Vida en común</h3><p>Impulsamos actividades para encontrarnos y disfrutar en familia.</p></article><article className="value-card"><span className="value-icon"><HeartHandshake /></span><h3>Solidaridad</h3><p>Creemos en una comunidad que colabora y cuida de sus personas.</p></article></div></section><section className="simple-cta"><div className="wrap"><h2>¿Te sumas a lo que nos une?</h2><Link className="button button-green" to="/alta">Hazte socio <ArrowRight size={18} /></Link></div></section></PublicLayout>;
}

type FormStatus = { kind: 'error' | 'success' | 'warning'; message: string } | null;
function Notice({ value }: { value: FormStatus }) {
  return value ? <div className={`form-notice ${value.kind}`} role={value.kind === 'error' ? 'alert' : 'status'}>{value.message}</div> : null;
}

function passwordError(password: string): string | null {
  if (password.length < 8 || new TextEncoder().encode(password).length > 72 || /[\x00-\x1f\x7f]/.test(password)) return 'La contraseña debe tener al menos 8 caracteres y un máximo de 72 bytes, sin caracteres de control.';
  return null;
}

function Contact() {
  const contactEmail = useContext(ContactEmailContext);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<FormStatus>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice(null);
    if (!name.trim() || !email.trim() || !message.trim()) { setNotice({ kind: 'error', message: 'Completa todos los campos antes de enviar tu mensaje.' }); return; }
    setBusy(true);
    try {
      const result = await request('/api/contact', { method: 'POST', body: JSON.stringify({ name: name.trim(), email: email.trim(), message: message.trim() }) });
      if (result.sent === false || result.delivered === false || result.deliveryStatus === 'failed' || result.delivery_status === 'failed') {
        setNotice({ kind: 'warning', message: typeof result.message === 'string' ? result.message : 'Tu mensaje se ha registrado, pero no se ha podido enviar por correo. Ponte en contacto con la asociación directamente.' });
      } else {
        setNotice({ kind: 'success', message: typeof result.message === 'string' ? result.message : 'Tu mensaje se ha enviado. Gracias por escribirnos.' }); setName(''); setEmail(''); setMessage('');
      }
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'No se ha podido enviar el mensaje.' }); }
    finally { setBusy(false); }
  }
  return <PublicLayout><section className="form-page"><div className="wrap form-layout"><div className="form-intro"><SectionLabel>HABLEMOS</SectionLabel><h1>El barrio empieza<br /><em>con un hola.</em></h1><p>¿Tienes una pregunta, una propuesta o algo que contarnos? Nos encantará escucharte.</p><div className="contact-detail"><span>ESCRÍBENOS TAMBIÉN A</span><a href={contactMailto(contactEmail)}>{contactEmail} <ArrowUpRight size={17} /></a></div><div className="contact-detail"><span>NOS ENCONTRARÁS EN</span><p>San Juan de Aznalfarache, Sevilla</p></div></div><div className="form-card"><div className="form-card-heading"><span>CONTACTO</span><h2>Cuéntanos.</h2><p>Todos los campos son obligatorios.</p></div><form onSubmit={submit}><label>Tu nombre<input required maxLength={160} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label><label>Correo electrónico<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Tu mensaje<textarea required maxLength={10000} rows={6} value={message} onChange={e => setMessage(e.target.value)} /></label><p className="form-hint">Utilizaremos tus datos para atender tu consulta. Puedes solicitar información sobre privacidad escribiéndonos al correo de la asociación.</p><Notice value={notice} /><button className="button button-green button-full" disabled={busy}>{busy ? 'Enviando…' : 'Enviar mensaje'} <ArrowRight size={18} /></button></form></div></div></section></PublicLayout>;
}

function Login() {
  const navigate = useNavigate(); const location = useLocation();
  const token = new URLSearchParams(location.search).get('reset');
  const [mode, setMode] = useState<'login' | 'forgot' | 'reset'>(token ? 'reset' : 'login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<FormStatus>(null);
  useEffect(() => { if (token) setMode('reset'); }, [token]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      if (mode === 'forgot') {
        const result = await request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
        setNotice({ kind: 'success', message: typeof result.message === 'string' ? result.message : 'Si existe una cuenta y el servicio está disponible, se enviarán instrucciones.' });
        return;
      }
      if (mode === 'reset') {
        const error = passwordError(password);
        if (error) throw new Error(error);
        if (password !== confirm) throw new Error('Las contraseñas no coinciden.');
        const result = await request('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
        setPassword(''); setConfirm(''); setMode('login'); navigate('/acceso', { replace: true });
        setNotice({ kind: 'success', message: typeof result.message === 'string' ? result.message : 'Contraseña actualizada. Inicia sesión de nuevo.' });
        return;
      }
      await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: email.trim(), password }) });
      const me = await request('/api/auth/me');
      const user = me.user as { role?: string } | null | undefined;
      if (!user) throw new Error('No se ha podido comprobar la sesión. Inténtalo de nuevo.');
      setPassword(''); navigate(user.role === 'admin' ? '/admin' : '/socios');
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'No se ha podido iniciar sesión.' }); }
    finally { setBusy(false); }
  }
  function changeMode(next: 'login' | 'forgot') { setMode(next); setNotice(null); setPassword(''); setConfirm(''); if (token) navigate('/acceso', { replace: true }); }
  return <PublicLayout><section className="form-page login-page"><div className="wrap form-layout"><div className="form-intro"><SectionLabel>ÁREA DE SOCIOS</SectionLabel><h1>Qué bien<br /><em>tenerte aquí.</em></h1><p>Accede a tu espacio para consultar los datos de tu vivienda, las cuotas y las actividades de la asociación.</p><div className="secure-note"><ShieldCheck size={22} /><span>Tu espacio privado, solo para ti.</span></div></div><div className="form-card"><div className="form-card-heading"><span>ACCESO</span><h2>{mode === 'forgot' ? 'Recupera tu acceso.' : mode === 'reset' ? 'Nueva contraseña.' : 'Entra en tu cuenta.'}</h2><p>{mode === 'forgot' ? 'Introduce tu correo y te enviaremos instrucciones si el servicio está disponible.' : mode === 'reset' ? 'Elige una contraseña nueva para tu cuenta.' : 'Introduce los datos con los que te registraste.'}</p></div><form onSubmit={submit}>
    {mode !== 'reset' && <label>Correo electrónico<input type="email" required maxLength={254} autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>}
    {mode !== 'forgot' && <label>{mode === 'reset' ? 'Nueva contraseña' : 'Contraseña'}<input type="password" required minLength={mode === 'reset' ? 8 : undefined} autoComplete={mode === 'reset' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} /></label>}
    {mode === 'reset' && <label>Repite la contraseña<input type="password" required minLength={8} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}
    {mode === 'login' && <button type="button" className="forgot-link" onClick={() => changeMode('forgot')}>¿Has olvidado tu contraseña?</button>}
    <Notice value={notice} /><button className="button button-green button-full" disabled={busy}>{busy ? 'Un momento…' : mode === 'forgot' ? 'Solicitar instrucciones' : mode === 'reset' ? 'Guardar contraseña' : 'Entrar'} <ArrowRight size={18} /></button>
    {mode !== 'login' && <button type="button" className="forgot-link" onClick={() => changeMode('login')}>Volver al acceso</button>}
    </form><p className="form-bottom">¿Aún no formas parte? <Link to="/alta">Hazte socio</Link></p></div></div></section></PublicLayout>;
}

type HouseholdMember = { name: string; relationship: string; birthDate: string };

function todayInMadrid(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

function isValidBirthDate(value: string, today: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (year < 1000 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1] && value <= today;
}

type PaymentPreference = 'manual' | 'single_card' | 'subscription';

function proofFileError(file: File): string | null {
  if (file.size === 0 || file.size > 8 * 1024 * 1024) return 'El justificante debe tener contenido y pesar como máximo 8 MiB.';
  if (!/\.(pdf|jpe?g|png)$/i.test(file.name) || (file.type && !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type))) {
    return 'El justificante debe ser un archivo PDF, JPEG o PNG.';
  }
  return null;
}

async function uploadTransferProof(file: File): Promise<void> {
  const response = await fetch('/api/member/transfer-proof', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'XMLHttpRequest', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await response.json() as ApiResult;
  if (!response.ok || data.ok !== true) throw new Error('No se ha podido confirmar el justificante.');
}

function Register() {
  const contactEmail = useContext(ContactEmailContext);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState(''); const [address, setAddress] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [privacy, setPrivacy] = useState(false);
  const [members, setMembers] = useState<HouseholdMember[]>([]); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<FormStatus>(null);
  const [paymentPreference, setPaymentPreference] = useState<PaymentPreference>('manual');
  const [proofFile, setProofFile] = useState<File | null>(null); const proofInput = useRef<HTMLInputElement>(null);
  const [uploadingProof, setUploadingProof] = useState(false); const [proofNotice, setProofNotice] = useState<FormStatus>(null);
  const [done, setDone] = useState(false);
  function updateMember(index: number, field: keyof HouseholdMember, value: string) { setMembers(items => items.map((item, i) => i === index ? { ...item, [field]: value } : item)); }
  function changePaymentPreference(value: PaymentPreference) {
    setPaymentPreference(value); setNotice(null);
    if (value !== 'manual') setProofFile(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return; setNotice(null);
    if (!name.trim() || !email.trim() || !address.trim()) { setNotice({ kind: 'error', message: 'Completa el nombre, el correo y la dirección de tu vivienda.' }); return; }
    const invalidPassword = passwordError(password);
    if (invalidPassword) { setNotice({ kind: 'error', message: invalidPassword }); return; }
    if (password !== confirm) { setNotice({ kind: 'error', message: 'Las contraseñas no coinciden.' }); return; }
    if (phone.trim() && !/^[+\d\s().-]{6,40}$/.test(phone.trim())) { setNotice({ kind: 'error', message: 'Introduce un teléfono válido.' }); return; }
    if (members.some(member => !member.name.trim() || !member.relationship.trim())) { setNotice({ kind: 'error', message: 'Completa el nombre y la relación de cada familiar añadido, o elimínalo.' }); return; }
    const today = todayInMadrid();
    if (!isValidBirthDate(birthDate, today)) { setNotice({ kind: 'error', message: 'Introduce una fecha de nacimiento real y no futura para el titular.' }); return; }
    const invalidMemberIndex = members.findIndex(member => member.birthDate && !isValidBirthDate(member.birthDate, today));
    if (invalidMemberIndex !== -1) { setNotice({ kind: 'error', message: `La fecha de nacimiento del familiar ${invalidMemberIndex + 1} debe ser real y no futura.` }); return; }
    if (paymentPreference === 'manual' && proofFile) {
      const error = proofFileError(proofFile);
      if (error) { setNotice({ kind: 'error', message: error }); return; }
    }
    if (!privacy) { setNotice({ kind: 'error', message: 'Debes aceptar el tratamiento de datos para solicitar el alta.' }); return; }
    setBusy(true);
    try {
      await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ name: name.trim(), email: email.trim(), password, phone: phone.trim(), address: address.trim(), privacyAccepted: privacy, birthDate, paymentPreference, members: members.map(member => ({ name: member.name.trim(), relationship: member.relationship.trim(), birthDate: member.birthDate })) }) });
      if (paymentPreference === 'manual' && proofFile) setUploadingProof(true);
      setPassword(''); setConfirm(''); setDone(true); window.scrollTo(0, 0);
      if (paymentPreference === 'manual' && proofFile) {
        try {
          await uploadTransferProof(proofFile);
          setProofNotice({ kind: 'success', message: 'El justificante se ha adjuntado para su revisión por la asociación.' });
        } catch {
          setProofNotice({ kind: 'warning', message: 'El alta sí ha quedado registrada, pero no hemos podido adjuntar el justificante o confirmar que se adjuntó. No repitas el registro; consulta con la asociación antes de enviarlo de nuevo.' });
        } finally { setUploadingProof(false); setProofFile(null); }
      }
    } catch (error) { setNotice({ kind: 'error', message: error instanceof Error ? error.message : 'No se ha podido completar el alta.' }); }
    finally { setBusy(false); }
  }
  return <PublicLayout><section className="form-page register-page"><div className="wrap form-layout"><div className="form-intro"><SectionLabel>FORMAR PARTE</SectionLabel><h1>Tu casa también<br /><em>es parte de esto.</em></h1><p>Una pequeña aportación compartida nos ayuda a hacer grandes cosas por nuestro barrio.</p><div className="join-facts"><div><strong>20 €</strong><span>al año por vivienda</span></div><p>2026 está exento. La cuota anual se aplica desde el 1 de enero de 2027.</p><p>Al completar este formulario no se realiza ningún cobro ni se solicitan datos de tarjeta.</p></div><p className="intro-small">Tu solicitud quedará pendiente de aprobación por la asociación.</p></div><div className="form-card register-card">{done ? <div className="registered"><span className="success-icon"><ShieldCheck size={30} /></span><h2>Gracias por sumarte.</h2><p>Tu alta se ha registrado y queda pendiente de aprobación por la asociación. Ya puedes acceder a tus datos con tu cuenta.</p><p>No se ha realizado ningún cobro.</p>{uploadingProof && <p role="status">Adjuntando el justificante; espera antes de salir de esta página.</p>}<Notice value={proofNotice} />{!uploadingProof && <Link className="button button-green" to="/acceso">Ir al acceso <ArrowRight size={18} /></Link>}</div> : <><div className="form-card-heading"><span>ALTA DE SOCIO</span><h2>Empecemos por ti.</h2><p>Los campos marcados con * son obligatorios.</p></div><form onSubmit={submit}>
    <label>Nombre y apellidos *<input required maxLength={160} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Fecha de nacimiento del titular *<input required type="date" min="1000-01-01" max={todayInMadrid()} autoComplete="bday" value={birthDate} onFocus={e => { e.currentTarget.max = todayInMadrid(); }} onChange={e => { setBirthDate(e.target.value); setNotice(null); }} onInvalid={() => setNotice({ kind: 'error', message: 'Introduce una fecha de nacimiento real y no futura para el titular.' })} /></label>
    <label>Correo electrónico *<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
    <div className="field-row"><label>Contraseña *<input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /><small>Al menos 8 caracteres.</small></label><label>Repite la contraseña *<input required type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label></div>
    <label>Dirección de la vivienda *<input required maxLength={255} autoComplete="street-address" value={address} onChange={e => setAddress(e.target.value)} /></label>
    <label>Teléfono <span className="optional">(opcional)</span><input type="tel" maxLength={40} autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
    <div className="member-fields"><h3>Personas de la unidad familiar</h3><p>Si quieres, puedes añadir un segundo asociado, tus hijos u otras personas de tu vivienda. Para cada persona añadida, indica su nombre y relación; su fecha de nacimiento es opcional. Podrás gestionarlas después.</p>{members.map((member, index) => <div className="member-entry" key={index}><div className="member-title"><strong>Familiar {index + 1}</strong><button type="button" className="remove-member" onClick={() => setMembers(items => items.filter((_, i) => i !== index))}>Eliminar</button></div><div className="field-row"><label>Nombre *<input required maxLength={160} value={member.name} onChange={e => updateMember(index, 'name', e.target.value)} /></label><label>Relación *<input required maxLength={80} value={member.relationship} onChange={e => updateMember(index, 'relationship', e.target.value)} /></label></div><label className="member-birth-date"><span>Fecha de nacimiento del familiar {index + 1} <span className="optional">(opcional)</span></span><input type="date" min="1000-01-01" max={todayInMadrid()} value={member.birthDate} onFocus={e => { e.currentTarget.max = todayInMadrid(); }} onChange={e => { updateMember(index, 'birthDate', e.target.value); setNotice(null); }} onInvalid={() => setNotice({ kind: 'error', message: `La fecha de nacimiento del familiar ${index + 1} debe ser real y no futura.` })} /></label></div>)}<button className="add-member" type="button" disabled={members.length >= 99} onClick={() => setMembers(items => [...items, { name: '', relationship: '', birthDate: '' }])}><Plus size={17} /> Añadir persona</button></div>
    <fieldset className="payment-options"><legend>Modalidad de pago *</legend><label className="payment-option"><input type="radio" name="paymentPreference" value="manual" checked={paymentPreference === 'manual'} onChange={() => changePaymentPreference('manual')} /><span>Transferencia o gestión manual</span></label><label className="payment-option"><input type="radio" name="paymentPreference" value="single_card" checked={paymentPreference === 'single_card'} onChange={() => changePaymentPreference('single_card')} /><span>Solicitar pago único con tarjeta</span></label><label className="payment-option"><input type="radio" name="paymentPreference" value="subscription" checked={paymentPreference === 'subscription'} onChange={() => changePaymentPreference('subscription')} /><span>Solicitar suscripción anual con tarjeta</span></label><p>Solicita los datos bancarios a la asociación. Las opciones con tarjeta son solo solicitudes: aún no están habilitadas en vivo y requieren aprobación y configuración de Stripe. No se inicia ningún pago al solicitar el alta; 2026 está exento.</p>{paymentPreference === 'manual' && <div className="proof-field"><label htmlFor="transfer-proof">Justificante de transferencia <span className="optional">(opcional)</span></label><input ref={proofInput} id="transfer-proof" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" aria-describedby="proof-hint" onChange={e => { const file = e.target.files?.[0] ?? null; setProofFile(file); const error = file && proofFileError(file); setNotice(error ? { kind: 'error', message: error } : null); }} /><p id="proof-hint">PDF, JPEG o PNG; máximo 8 MiB. Se enviará después de registrar el alta.</p>{proofFile && <button type="button" className="remove-member" onClick={() => { setProofFile(null); if (proofInput.current) proofInput.current.value = ''; setNotice(null); }}>Quitar justificante</button>}</div>}</fieldset>
    <div className="privacy-box"><p><strong>Información sobre privacidad.</strong> La Asociación de Vecinos Vega de San Juan utilizará los datos facilitados, incluida la fecha de nacimiento del titular y, si los añades, el nombre, la relación y la fecha de nacimiento de cada miembro, para tramitar tu solicitud y gestionar la relación con la asociación. La fecha de nacimiento de cada miembro es opcional. Incluye datos de otras personas, especialmente de menores, solo si estás autorizado a facilitarlos. Si adjuntas un justificante, se utilizará para revisar el pago. Puedes solicitar información o ejercer tus derechos escribiendo a <a href={contactMailto(contactEmail)}>{contactEmail}</a>.</p><label className="check-label"><input type="checkbox" required checked={privacy} onChange={e => setPrivacy(e.target.checked)} /><span>He leído esta información y consiento el tratamiento de los datos facilitados para tramitar el alta. *</span></label></div>
    <Notice value={notice} /><button className="button button-green button-full" disabled={busy}>{busy ? 'Enviando solicitud…' : 'Solicitar el alta'} <ArrowRight size={18} /></button><p className="form-hint center">Al solicitar el alta no se realiza ningún pago.</p>
    </form><p className="form-bottom">¿Ya tienes cuenta? <Link to="/acceso">Accede aquí</Link></p></>}</div></div></section></PublicLayout>;
}

function NotFound() {
  return <PublicLayout><section className="inner-hero not-found"><div className="wrap"><SectionLabel>NO ENCONTRAMOS ESTA PÁGINA</SectionLabel><h1>Esta calle no<br /><em>aparece en el mapa.</em></h1><p>Quizá el enlace ha cambiado. Vuelve al inicio y seguimos por allí.</p><Link className="button button-green" to="/">Volver al inicio <ArrowRight size={18} /></Link></div></section></PublicLayout>;
}

export default function App() {
  const [contactEmail, setContactEmail] = useState(fallbackContactEmail);
  useEffect(() => {
    let mounted = true;
    request('/api/public/config').then(data => {
      const settings = data.settings;
      const email = settings && typeof settings === 'object' && 'contactEmail' in settings ? settings.contactEmail : null;
      if (mounted && typeof email === 'string') {
        const cleaned = email.trim();
        if (cleaned.length <= 254 && !/[\x00-\x1f\x7f]/.test(cleaned) && /^[^\s@<>(),;:\\"\[\]]+@[^\s@<>(),;:\\"\[\]]+\.[^\s@<>(),;:\\"\[\]]+$/u.test(cleaned)) setContactEmail(cleaned);
      }
    }).catch(() => { /* Conserva el correo público de referencia si no hay configuración válida. */ });
    return () => { mounted = false; };
  }, []);
  return <ContactEmailContext.Provider value={contactEmail}><RouteEffects /><Routes><Route path="/" element={<Home />} /><Route path="/asociacion" element={<Association />} /><Route path="/contacto" element={<Contact />} /><Route path="/alta" element={<Register />} /><Route path="/acceso" element={<Login />} /><Route path="/socios/*" element={<MemberArea />} /><Route path="/admin/*" element={<AdminArea />} /><Route path="*" element={<NotFound />} /></Routes></ContactEmailContext.Provider>;
}
