import {
  Activity,
  ArrowRight,
  Award,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Coins,
  Copy,
  Download,
  Eye,
  EyeOff,
  Flame,
  Gift,
  History,
  ImagePlus,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  LockKeyhole,
  LogOut,
  Menu,
  MoonStar,
  RotateCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  TicketCheck,
  TimerReset,
  Trash2,
  Trophy,
  Upload,
  X
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SUPPORTED_TIMEZONES, TIMEZONE_OPTIONS } from "../shared/constants";
import { presentRewardSnapshot } from "../shared/rewards";
import { api, ApiError, idempotencyKey } from "./api";

type Bootstrap = {
  initialized: boolean;
  setup_protected: boolean;
  timezone: string;
  user_label: string;
  ai_label: string;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type Overview = {
  statistics: {
    balance: number;
    totalEarned: number;
    totalSpent: number;
    totalPenalties: number;
    currentStreak: number;
    longestStreak: number;
    totalActiveDays: number;
    totalCompletedTasks: number;
    byType: Record<string, number>;
    byDifficulty: Record<string, number>;
  };
  today: { date: string; completed: number; active: boolean };
  queues: { pending_tasks: number; awaiting_review: number; pending_redemptions: number };
  recent_achievements: Array<{ achievement: Achievement; unlockedAt: string }>;
  labels: { user: string; ai: string };
  timezone: string;
};

type Task = {
  id: string;
  seriesId?: string | null;
  title: string;
  description: string;
  type: "daily" | "challenge" | "surprise";
  difficulty: "easy" | "medium" | "hard";
  basePoints: number;
  status: "pending" | "submitted" | "completed" | "failed" | "expired" | "cancelled";
  verificationMode: "self" | "ai_review";
  proofRequirement: string;
  deadlineAt?: string | null;
  completionDate?: string | null;
  createdAt: string;
  occurrenceDate?: string | null;
  submissions?: Array<{
    id: string;
    proofText: string;
    status: string;
    submittedAt: string;
    reviewReason?: string;
    assets: Array<{ id: string; width: number; height: number }>;
  }>;
};

type Achievement = {
  id: string;
  name: string;
  description: string;
  category: string;
  threshold: number;
  icon: string;
  unlocks?: Array<{ unlockedAt: string }>;
};

const typeLabel = { daily: "日常", challenge: "挑战", surprise: "惊喜" };
const difficultyLabel = { easy: "轻盈", medium: "认真", hard: "高难" };
const statusLabel = {
  pending: "待完成",
  submitted: "待确认",
  completed: "已完成",
  failed: "未通过",
  expired: "已逾期",
  cancelled: "已取消"
};

const supportedTimezoneValues = new Set<string>(SUPPORTED_TIMEZONES);

function defaultTimezone() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return supportedTimezoneValues.has(detected) ? detected : "Asia/Shanghai";
}

function formatDate(value?: string | null, withTime = false) {
  if (!value) return "没有期限";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(new Date(value));
}

function pointsFor(task: Task) {
  return task.basePoints * ({ easy: 1, medium: 2, hard: 3 }[task.difficulty] ?? 1);
}

function FullPageLoader() {
  return (
    <div className="splash">
      <div className="phosphene-mark phosphene-mark--large" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p>正在唤醒你的私人光点…</p>
    </div>
  );
}

function AuthBackdrop({ children, eyebrow, title, copy }: { children: ReactNode; eyebrow: string; title: string; copy: string }) {
  return (
    <main className="auth-page">
      <div className="auth-ambient ambient-one" />
      <div className="auth-ambient ambient-two" />
      <section className="auth-story">
        <div className="brand-lockup brand-lockup--light">
          <div className="phosphene-mark">
            <span />
            <span />
            <span />
          </div>
          <span>PHOSPHENE</span>
        </div>
        <div className="auth-story__copy">
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{copy}</p>
        </div>
        <blockquote>“有些约定不必被看见，只需要被彼此记得。”</blockquote>
      </section>
      <section className="auth-panel">{children}</section>
    </main>
  );
}

function SetupPage({
  setupProtected,
  onReady
}: {
  setupProtected: boolean;
  onReady: (bootstrap: Bootstrap) => void;
}) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tokenResult, setTokenResult] = useState<{ ai_token: string } | null>(null);
  const [form, setForm] = useState({
    setup_token: "",
    password: "",
    passwordConfirm: "",
    timezone: defaultTimezone(),
    user_label: "你",
    ai_label: "AI"
  });
  const [showPassword, setShowPassword] = useState(false);

  function credentialError() {
    if (setupProtected && !form.setup_token.trim()) return "请输入部署时设置的 Setup Token。";
    if (form.password.length < 10) return "登录密码至少需要 10 个字符。";
    if (form.password.length > 256) return "登录密码不能超过 256 个字符。";
    if (form.password !== form.passwordConfirm) return "两次输入的密码不一致。";
    return "";
  }

  function continueSetup() {
    const message = credentialError();
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setStep(2);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const message = credentialError();
    if (message) {
      setError(message);
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ ai_token: string }>("/setup", {
        method: "POST",
        body: {
          setup_token: form.setup_token,
          password: form.password,
          timezone: form.timezone,
          user_label: form.user_label,
          ai_label: form.ai_label
        }
      });
      setTokenResult(result);
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "设置没有完成。");
    } finally {
      setBusy(false);
    }
  }

  if (step === 3 && tokenResult) {
    return (
      <AuthBackdrop eyebrow="准备完成" title="现在，信号已经亮了。" copy={`这是 ${form.ai_label} 连接 Phosphene 的唯一凭证。它只展示这一次。`}>
        <div className="auth-form">
          <div className="success-orbit">
            <Check />
          </div>
          <p className="step-label">最后一步 · 保存连接 Token</p>
          <h2>收好这把钥匙</h2>
          <p className="muted">复制并保存在密码管理器中。之后如果遗失，只能在设置中轮换。</p>
          <SecretBox value={tokenResult.ai_token} />
          <button
            className="button button--primary button--wide"
            onClick={() =>
              onReady({
                initialized: true,
                setup_protected: setupProtected,
                timezone: form.timezone,
                user_label: form.user_label,
                ai_label: form.ai_label
              })
            }
          >
            进入 Phosphene <ArrowRight size={17} />
          </button>
        </div>
      </AuthBackdrop>
    );
  }

  return (
    <AuthBackdrop
      eyebrow="PRIVATE BY DESIGN"
      title="把你们之间的节奏，留在自己的空间里。"
      copy="Phosphene 将任务、承诺、积分和奖励留在你自己的服务器上。没有公开注册，也没有多余的旁观者。"
    >
      <form className="auth-form" onSubmit={submit}>
        <div className="step-row">
          {[1, 2].map((item) => (
            <span key={item} className={step >= item ? "active" : ""}>
              {item}
            </span>
          ))}
        </div>
        <p className="step-label">首次设置 · {step}/2</p>
        <h2>
          {step === 1
            ? setupProtected
              ? "先确认这是你的空间"
              : "认领你的 Phosphene"
            : "再告诉我，怎么称呼你们"}
        </h2>
        <p className="muted">
          {step === 1
            ? setupProtected
              ? "这个实例启用了 Setup Token 保护，验证后才能设置唯一的登录密码。"
              : "这是一个尚未认领的新实例。设置密码并完成初始化后，首次设置入口会永久关闭。"
            : "这些称呼只影响页面展示，不会改变连接权限与数据边界。"}
        </p>
        {error && <InlineError message={error} />}
        {step === 1 ? (
          <>
            {setupProtected && (
              <Field label="Setup Token">
                <input
                  autoFocus
                  required
                  value={form.setup_token}
                  onChange={(event) => setForm({ ...form, setup_token: event.target.value })}
                  placeholder="粘贴部署时设置的 Setup Token"
                />
              </Field>
            )}
            <Field label="登录密码" hint="至少 10 个字符">
              <div className="input-with-icon">
                <input
                  autoFocus={!setupProtected}
                  required
                  minLength={10}
                  maxLength={256}
                  type={showPassword ? "text" : "password"}
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  placeholder="为网站设置一个强密码"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} aria-label="显示或隐藏密码">
                  {showPassword ? <EyeOff /> : <Eye />}
                </button>
              </div>
            </Field>
            <Field label="再次输入密码">
              <input
                required
                minLength={10}
                maxLength={256}
                type={showPassword ? "text" : "password"}
                value={form.passwordConfirm}
                onChange={(event) => setForm({ ...form, passwordConfirm: event.target.value })}
                placeholder="确认刚才的密码"
              />
            </Field>
            <button type="button" className="button button--primary button--wide" onClick={continueSetup}>
              继续 <ArrowRight size={17} />
            </button>
          </>
        ) : (
          <>
            <div className="field-grid">
              <Field label="user 的称呼">
                <input
                  required
                  value={form.user_label}
                  onChange={(event) => setForm({ ...form, user_label: event.target.value })}
                />
              </Field>
              <Field label="陪伴者的称呼">
                <input
                  required
                  value={form.ai_label}
                  onChange={(event) => setForm({ ...form, ai_label: event.target.value })}
                />
              </Field>
            </div>
            <Field label="时区" hint="积分与连击按这个自然日计算">
              <TimezoneSelect
                value={form.timezone}
                onChange={(event) => setForm({ ...form, timezone: event.target.value })}
              />
            </Field>
            <div className="button-row">
              <button type="button" className="button button--ghost" onClick={() => setStep(1)}>
                返回
              </button>
              <button className="button button--primary button--grow" disabled={busy}>
                {busy ? "正在创建…" : "完成设置"} <Sparkles size={17} />
              </button>
            </div>
          </>
        )}
        <p className="security-note">
          <ShieldCheck size={15} /> 密码使用 Argon2id 加密；Phosphene 不提供找回密码入口。
        </p>
      </form>
    </AuthBackdrop>
  );
}

function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/login", { method: "POST", body: { password } });
      onLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录没有成功。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthBackdrop eyebrow="WELCOME BACK" title="你回来了，信号还在。" copy="待完成的约定、累积的分数，还有那条仍在延伸的轨迹，都留在原处等你。">
      <form className="auth-form" onSubmit={submit}>
        <p className="step-label">私人入口</p>
        <h2>进入 Phosphene</h2>
        <p className="muted">这里没有用户名，因为这一份空间只属于一个人。</p>
        {error && <InlineError message={error} />}
        <Field label="密码">
          <div className="input-with-icon">
            <input
              autoFocus
              required
              type={show ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入你的登录密码"
            />
            <button type="button" onClick={() => setShow(!show)} aria-label="显示或隐藏密码">
              {show ? <EyeOff /> : <Eye />}
            </button>
          </div>
        </Field>
        <button className="button button--primary button--wide" disabled={busy}>
          {busy ? "正在确认…" : "进入"} <ArrowRight size={17} />
        </button>
        <p className="security-note">
          <LockKeyhole size={15} /> 会话使用安全 Cookie 保存在这台设备上。
        </p>
      </form>
    </AuthBackdrop>
  );
}

function AppShell({
  bootstrap,
  installPrompt,
  installed,
  onInstall,
  onIdentityChanged,
  onLogout
}: {
  bootstrap: Bootstrap;
  installPrompt: InstallPromptEvent | null;
  installed: boolean;
  onInstall: () => Promise<void>;
  onIdentityChanged: (settings: Pick<Bootstrap, "timezone" | "user_label" | "ai_label">) => void;
  onLogout: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  const nav = [
    ["/", "今日", LayoutDashboard],
    ["/tasks", "任务", ListTodo],
    ["/rewards", "兑换", Store],
    ["/insights", "轨迹", Activity],
    ["/history", "历史", History],
    ["/settings", "设置", Settings]
  ] as const;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__top">
          <div className="brand-lockup">
            <div className="phosphene-mark">
              <span />
              <span />
              <span />
            </div>
            <span>PHOSPHENE</span>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setMobileOpen(false)} aria-label="关闭菜单">
            <X />
          </button>
        </div>
        <nav className="side-nav">
          <p>你的空间</p>
          {nav.map(([to, label, Icon]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <Icon size={19} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="pair-signal" aria-label={`${bootstrap.user_label} 与 ${bootstrap.ai_label} 的私人空间`}>
            <span>{bootstrap.user_label.slice(0, 1)}</span>
            <i />
            <span>{bootstrap.ai_label.slice(0, 1)}</span>
            <small>一份部署 · 两个称呼 · 没有旁观者</small>
          </div>
          <div className="privacy-chip">
            <ShieldCheck size={17} />
            <div>
              <strong>私人部署</strong>
              <span>数据只在你的服务器</span>
            </div>
          </div>
          <button className="text-button" onClick={onLogout}>
            <LogOut size={17} /> 退出登录
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMobileOpen(true)} aria-label="打开菜单">
            <Menu />
          </button>
          <span>PHOSPHENE</span>
          <div className="mini-orbit" />
        </header>
        <Routes>
          <Route path="/" element={<Dashboard aiLabel={bootstrap.ai_label} />} />
          <Route path="/tasks" element={<TasksPage aiLabel={bootstrap.ai_label} />} />
          <Route path="/rewards" element={<RewardsPage aiLabel={bootstrap.ai_label} />} />
          <Route path="/insights" element={<InsightsPage />} />
          <Route path="/history" element={<HistoryPage aiLabel={bootstrap.ai_label} />} />
          <Route
            path="/settings"
            element={
              <SettingsPage
                installAvailable={Boolean(installPrompt)}
                installed={installed}
                onInstall={onInstall}
                onIdentityChanged={onIdentityChanged}
              />
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {nav.slice(0, 5).map(([to, label, Icon]) => (
          <NavLink key={to} to={to} end={to === "/"}>
            <Icon size={20} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      {mobileOpen && <button className="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-label="关闭菜单" />}
    </div>
  );
}

function PageHeader({
  eyebrow,
  title,
  copy,
  action
}: {
  eyebrow: string;
  title: string;
  copy?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {copy && <p>{copy}</p>}
      </div>
      {action}
    </header>
  );
}

function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (showLoading: boolean) => {
    if (showLoading) setLoading(true);
    try {
      setData(await loader());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败。");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, dependencies);
  const refresh = useCallback(() => load(true), [load]);
  const revalidate = useCallback(() => load(false), [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, error, loading, refresh, revalidate };
}

function Dashboard({ aiLabel }: { aiLabel: string }) {
  const { data, error, loading, refresh } = useLoad<Overview>(() => api("/overview"), []);
  const tasks = useLoad<{ items: Task[] }>(() => api("/tasks?status=pending&limit=6"), []);
  if (loading && !data) return <PageLoader />;
  if (error || !data) return <PageError message={error} retry={refresh} />;
  const hour = new Date().getHours();
  const greeting = hour < 6 ? "夜还很深" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow={new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}
        title={`${greeting}，${data.labels.user}`}
        copy={data.today.active ? "今天的回应已经被记住。余下的事，可以从容一点。" : "今天还没有点亮。挑一件最容易开始的事吧。"}
        action={
          <div className={`today-pulse ${data.today.active ? "today-pulse--lit" : ""}`}>
            <span />
            {data.today.active ? "今日已点亮" : "等待第一次回应"}
          </div>
        }
      />
      <section className="hero-grid">
        <article className="streak-hero">
          <div className="streak-orbit" aria-hidden="true">
            <span />
            <span />
            <Flame />
          </div>
          <div>
            <p>当前连击</p>
            <strong>{data.statistics.currentStreak}</strong>
            <span>天</span>
          </div>
          <footer>
            <span>最长 {data.statistics.longestStreak} 天</span>
            <span>第 8 天起每日 +3</span>
          </footer>
        </article>
        <article className="balance-card">
          <div className="card-icon"><Coins /></div>
          <div>
            <p>可用积分</p>
            <strong>{data.statistics.balance}</strong>
            <span> points</span>
          </div>
          <NavLink to="/rewards">去看看能换什么 <ChevronRight size={16} /></NavLink>
        </article>
        <article className="mini-stat">
          <CheckCircle2 />
          <div><strong>{data.statistics.totalCompletedTasks}</strong><span>完成任务</span></div>
        </article>
        <article className="mini-stat">
          <CalendarDays />
          <div><strong>{data.statistics.totalActiveDays}</strong><span>总坚持天数</span></div>
        </article>
      </section>

      <section className="content-grid">
        <div className="content-column">
          <SectionHeading title="此刻要做的事" copy={`${data.queues.pending_tasks} 件待完成 · ${data.queues.awaiting_review} 件等待确认`} to="/tasks" />
          <div className="task-stack">
            {tasks.data?.items.length ? (
              tasks.data.items.map((task) => <TaskCard key={task.id} task={task} aiLabel={data.labels.ai || aiLabel} onChanged={() => void Promise.all([refresh(), tasks.refresh()])} />)
            ) : (
              <EmptyState icon={<MoonStar />} title="现在没有待完成的任务" copy={`享受这段留白，或者等 ${data.labels.ai || aiLabel} 留下一份新的约定。`} />
            )}
          </div>
        </div>
        <aside className="content-aside">
          <div className="queue-card">
            <SectionHeading title="等待回应" />
            <QueueItem icon={<TimerReset />} label={`等待 ${data.labels.ai || aiLabel} 确认`} value={data.queues.awaiting_review} tone="amber" />
            <QueueItem icon={<TicketCheck />} label="等待奖励履行" value={data.queues.pending_redemptions} tone="violet" />
          </div>
          <div className="achievement-peek">
            <div className="card-icon"><Award /></div>
            <p>最近解锁</p>
            {data.recent_achievements[0] ? (
              <>
                <strong>{data.recent_achievements[0].achievement.name}</strong>
                <span>{data.recent_achievements[0].achievement.description}</span>
              </>
            ) : (
              <>
                <strong>第一束光</strong>
                <span>完成第一个任务后，它会在这里出现。</span>
              </>
            )}
            <NavLink to="/insights">查看全部成就 <ChevronRight size={15} /></NavLink>
          </div>
        </aside>
      </section>
    </div>
  );
}

function SectionHeading({ title, copy, to }: { title: string; copy?: string; to?: string }) {
  return (
    <div className="section-heading">
      <div><h2>{title}</h2>{copy && <p>{copy}</p>}</div>
      {to && <NavLink to={to}>查看全部 <ArrowRight size={15} /></NavLink>}
    </div>
  );
}

function QueueItem({ icon, label, value, tone }: { icon: ReactNode; label: string; value: number; tone: string }) {
  return (
    <div className="queue-item">
      <span className={`queue-item__icon ${tone}`}>{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskCard({ task, aiLabel, onChanged }: { task: Task; aiLabel: string; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <article className={`task-card task-card--${task.type}`} onClick={() => setOpen(true)}>
        <div className="task-card__type">
          {task.type === "daily" ? <CalendarDays /> : task.type === "challenge" ? <Flame /> : <Gift />}
        </div>
        <div className="task-card__body">
          <div className="task-card__meta">
            <span>{typeLabel[task.type]}</span>
            <span className={`difficulty difficulty--${task.difficulty}`}>{difficultyLabel[task.difficulty]}</span>
            {task.seriesId && <span>每日重复</span>}
          </div>
          <h3>{task.title}</h3>
          <p>{task.description || (task.proofRequirement === "none" ? "完成后，记得回来确认。" : "这项任务需要提交完成证据。")}</p>
          <footer>
            <span><Clock3 /> {formatDate(task.deadlineAt, true)}</span>
            <span className="task-points">+{pointsFor(task)}</span>
          </footer>
        </div>
        <ChevronRight className="task-card__chevron" />
      </article>
      {open && <TaskDialog taskId={task.id} initialTask={task} aiLabel={aiLabel} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

function TaskDialog({
  taskId,
  initialTask,
  aiLabel,
  onClose,
  onChanged
}: {
  taskId: string;
  initialTask: Task;
  aiLabel: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [task, setTask] = useState(initialTask);
  const [proofText, setProofText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void api<Task>(`/tasks/${taskId}`).then(setTask).catch(() => {});
  }, [taskId]);
  async function submit() {
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("proof_text", proofText);
    files.forEach((file) => form.append("images", file));
    try {
      await api(`/tasks/${task.id}/submit`, { method: "POST", body: form });
      setTask(await api(`/tasks/${task.id}`));
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交失败。");
    } finally {
      setBusy(false);
    }
  }
  const latest = task.submissions?.[0];
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="dialog task-dialog" role="dialog" aria-modal="true" aria-label={task.title}>
        <header>
          <div className={`task-symbol task-symbol--${task.type}`}>
            {task.type === "daily" ? <CalendarDays /> : task.type === "challenge" ? <Flame /> : <Gift />}
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X /></button>
        </header>
        <div className="task-dialog__meta">
          <span>{typeLabel[task.type]}</span>
          <span className={`difficulty difficulty--${task.difficulty}`}>{difficultyLabel[task.difficulty]}</span>
          <span className={`status status--${task.status}`}>{statusLabel[task.status]}</span>
        </div>
        <h2>{task.title}</h2>
        <p className="task-description">{task.description || "没有额外说明。"}</p>
        <div className="detail-strip">
          <div><Coins /><span>完成奖励</span><strong>+{pointsFor(task)}</strong></div>
          <div><Clock3 /><span>截止时间</span><strong>{formatDate(task.deadlineAt, true)}</strong></div>
          <div><ShieldCheck /><span>确认方式</span><strong>{task.verificationMode === "self" ? "自己确认" : `${aiLabel} 确认`}</strong></div>
        </div>
        {task.status === "pending" && (
          <div className="submission-box">
            <div>
              <h3>提交完成</h3>
              <span>证据要求：{proofLabel(task.proofRequirement)}</span>
            </div>
            {error && <InlineError message={error} />}
            {task.proofRequirement !== "none" && task.proofRequirement !== "image" && (
              <textarea value={proofText} onChange={(event) => setProofText(event.target.value)} placeholder="写下完成情况、感受或相关记录…" rows={4} />
            )}
            {["image", "text_or_image", "text_and_image"].includes(task.proofRequirement) && (
              <>
                <input
                  hidden
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  onChange={(event) => setFiles([...event.target.files ?? []].slice(0, 4))}
                />
                <button className="upload-zone" onClick={() => fileRef.current?.click()}>
                  <ImagePlus />
                  <strong>{files.length ? `已选择 ${files.length} 张图片` : "添加图片证据"}</strong>
                  <span>JPEG、PNG 或 WebP · 最多 4 张 · 单张 10 MB</span>
                </button>
                {files.length > 0 && (
                  <div className="file-chips">
                    {files.map((file, index) => (
                      <span key={`${file.name}-${index}`}>{file.name}<button onClick={() => setFiles(files.filter((_, item) => item !== index))}><X /></button></span>
                    ))}
                  </div>
                )}
              </>
            )}
            <button className="button button--primary button--wide" disabled={busy} onClick={submit}>
              {busy ? "正在提交…" : task.verificationMode === "self" ? "确认完成" : `提交给 ${aiLabel} 确认`} <Check size={17} />
            </button>
          </div>
        )}
        {task.status === "submitted" && (
          <div className="state-message state-message--waiting">
            <TimerReset />
            <div><strong>已经送达，正在等待确认</strong><span>提交时间 {formatDate(latest?.submittedAt, true)}。连击会按提交当天计算。</span></div>
          </div>
        )}
        {task.status === "completed" && (
          <div className="state-message state-message--success">
            <CheckCircle2 />
            <div><strong>这件事已经被好好完成</strong><span>{task.completionDate} · 获得 {pointsFor(task)} 积分</span></div>
          </div>
        )}
        {latest?.assets?.length ? (
          <div className="proof-gallery">
            {latest.assets.map((asset) => <img key={asset.id} src={`/api/proofs/${asset.id}`} alt="任务证据" />)}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function proofLabel(value: string) {
  return {
    none: "无需证据",
    text: "文字说明",
    image: "图片",
    text_or_image: "文字或图片",
    text_and_image: "文字和图片"
  }[value] ?? value;
}

function TasksPage({ aiLabel }: { aiLabel: string }) {
  const [status, setStatus] = useState("active");
  const [type, setType] = useState("all");
  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: "100", include_proof: "false" });
    if (status !== "all" && status !== "active") params.set("status", status);
    if (type !== "all") params.set("type", type);
    return params.toString();
  }, [status, type]);
  const { data, error, loading, refresh } = useLoad<{ items: Task[] }>(() => api(`/tasks?${query}`), [query]);
  const items = (data?.items ?? []).filter((task) =>
    status === "active" ? ["pending", "submitted"].includes(task.status) : true
  );
  return (
    <div className="page">
      <PageHeader eyebrow="TASKS" title="所有约定" copy="一次性的认真、每天的照料，和不经意落下的惊喜。" />
      <div className="filter-bar">
        <div className="segmented">
          {[
            ["active", "进行中"],
            ["pending", "待完成"],
            ["submitted", "待确认"],
            ["completed", "已完成"],
            ["all", "全部"]
          ].map(([value, label]) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{label}</button>)}
        </div>
        <select value={type} onChange={(event) => setType(event.target.value)} aria-label="任务类型">
          <option value="all">全部类型</option>
          <option value="daily">日常</option>
          <option value="challenge">挑战</option>
          <option value="surprise">惊喜</option>
        </select>
      </div>
      {loading ? <PageLoader compact /> : error ? <PageError message={error} retry={refresh} /> : items.length ? (
        <div className="task-grid">{items.map((task) => <TaskCard key={task.id} task={task} aiLabel={aiLabel} onChanged={refresh} />)}</div>
      ) : (
        <EmptyState icon={<ListTodo />} title="这个分类里还没有任务" copy={`换一个筛选条件看看，或者等待 ${aiLabel} 创建新的安排。`} />
      )}
    </div>
  );
}

function RewardsPage({ aiLabel }: { aiLabel: string }) {
  const overview = useLoad<Overview>(() => api("/overview"), []);
  const rewards = useLoad<any[]>(() => api("/rewards"), []);
  const redemptions = useLoad<any[]>(() => api("/redemptions"), []);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  const visibleAiLabel = overview.data?.labels.ai || aiLabel;
  const sync = useCallback(async (showFeedback = false) => {
    if (showFeedback) setSyncing(true);
    await Promise.all([overview.revalidate(), rewards.revalidate(), redemptions.revalidate()]);
    if (showFeedback) setSyncing(false);
  }, [overview.revalidate, rewards.revalidate, redemptions.revalidate]);
  useEffect(() => {
    const onFocus = () => void sync();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void sync();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void sync();
    }, 30_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [sync]);
  async function redeem(item: any) {
    if (!confirm(`使用 ${item.cost} 积分兑换“${item.name}”？`)) return;
    setRedeeming(item.id);
    try {
      await api(`/rewards/${item.id}/redeem`, {
        method: "POST",
        body: { idempotency_key: idempotencyKey("redeem") }
      });
      setNotice(`兑换成功，${item.cost} 积分已扣除。现在等待 ${visibleAiLabel} 履行“${item.name}”。`);
      await sync();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "兑换失败。");
    } finally {
      setRedeeming(null);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="REWARDS"
        title="把积分变成愿望"
        copy="每一次完成都不是抽象的数字，它们可以在这里换成真正想要的回应。"
        action={
          <div className="rewards-header-actions">
            <button className="button button--secondary rewards-sync" type="button" disabled={syncing} onClick={() => void sync(true)}>
              <RotateCw size={16} />{syncing ? "同步中…" : "同步奖励"}
            </button>
            <div className="header-balance"><Coins /><span>可用</span><strong>{overview.data?.statistics.balance ?? "—"}</strong></div>
          </div>
        }
      />
      {notice && <div className="notice-banner"><Sparkles />{notice}<button onClick={() => setNotice("")}><X /></button></div>}
      {rewards.loading ? <PageLoader compact /> : rewards.error && !rewards.data ? <PageError message={rewards.error} retry={rewards.refresh} /> : rewards.data?.length ? (
        <section className="reward-grid">
          {rewards.data?.map((item, index) => (
            <article className="reward-card" key={item.id}>
              <div className={`reward-illustration reward-illustration--${index % 4}`}>
                {index % 4 === 0 ? <Sparkles /> : index % 4 === 1 ? <MoonStar /> : index % 4 === 2 ? <Star /> : <Gift />}
                <span />
              </div>
              <div className="reward-card__body">
                <p>可兑换奖励</p>
                <h2>{item.name}</h2>
                <span>{item.description}</span>
                <footer>
                  <strong><Coins /> {item.cost}</strong>
                  <button
                    className="button button--small"
                    disabled={redeeming === item.id || (overview.data?.statistics.balance ?? 0) < item.cost}
                    onClick={() => redeem(item)}
                  >
                    {(overview.data?.statistics.balance ?? 0) < item.cost ? "积分不足" : redeeming === item.id ? "兑换中…" : "兑换"}
                  </button>
                </footer>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <EmptyState
          icon={<Gift />}
          title="兑换清单还没有内容"
          copy={`${visibleAiLabel} 可以通过 Phosphene 连接创建只属于你们的奖励。`}
        />
      )}
      <section className="section-block">
        <SectionHeading title="兑换记录" copy="许下的愿望与已经兑现的回应" />
        <div className="redemption-list">
          {redemptions.data?.length ? redemptions.data.map((item) => (
            <div className="redemption-row" key={item.id}>
              <span className={`redemption-status redemption-status--${item.status}`}>{item.status === "pending" ? <Clock3 /> : <Check />}</span>
              <div><strong>{presentRewardSnapshot(item.itemNameSnapshot, visibleAiLabel)}</strong><span>{formatDate(item.redeemedAt, true)}</span></div>
              <span>-{item.costSnapshot}</span>
              <em>{item.status === "fulfilled" ? "已履行" : item.status === "cancelled" ? "已取消" : "等待履行"}</em>
            </div>
          )) : <EmptyState compact icon={<Gift />} title="还没有兑换记录" copy="攒下的积分，会在合适的时候变成愿望。" />}
        </div>
      </section>
    </div>
  );
}

function InsightsPage() {
  const overview = useLoad<Overview>(() => api("/overview"), []);
  const achievements = useLoad<Achievement[]>(() => api("/achievements"), []);
  if (overview.loading || achievements.loading) return <div className="page"><PageLoader /></div>;
  if (!overview.data) return <div className="page"><PageError message={overview.error} retry={overview.refresh} /></div>;
  const stats = overview.data.statistics;
  return (
    <div className="page">
      <PageHeader eyebrow="YOUR TRACE" title="留下来的轨迹" copy="不是为了追赶任何人，只是让你看见：那些认真回应过的日子，已经组成了什么。" />
      <section className="insight-hero">
        <div className="orbit-chart">
          <div><strong>{stats.currentStreak}</strong><span>当前连击</span></div>
          <i /><i /><i />
        </div>
        <div className="insight-copy">
          <p className="eyebrow">STREAK</p>
          <h2>{stats.currentStreak ? `连续 ${stats.currentStreak} 天，你仍然在回应。` : "下一次完成，就是新轨迹的起点。"}</h2>
          <p>最长连击为 {stats.longestStreak} 天。连击不限制任务类型，每个自然日至少完成一个任务即可延续。</p>
          <div className="streak-legend">
            <span><i /> 第 1 天 0</span><span><i /> 2–5 天 +1</span><span><i /> 6–7 天 +2</span><span><i /> 8 天起 +3</span>
          </div>
        </div>
      </section>
      <section className="stats-grid">
        <StatCard icon={<CheckCircle2 />} label="累计完成" value={stats.totalCompletedTasks} suffix="项" />
        <StatCard icon={<CalendarDays />} label="总坚持天数" value={stats.totalActiveDays} suffix="天" />
        <StatCard icon={<Sparkles />} label="累计获得" value={stats.totalEarned} suffix="分" />
        <StatCard icon={<Trophy />} label="最长连击" value={stats.longestStreak} suffix="天" />
      </section>
      <section className="breakdown-grid">
        <Breakdown title="按任务类型" values={[
          ["日常", stats.byType.daily ?? 0, "coral"],
          ["挑战", stats.byType.challenge ?? 0, "violet"],
          ["惊喜", stats.byType.surprise ?? 0, "gold"]
        ]} />
        <Breakdown title="按难度" values={[
          ["轻盈", stats.byDifficulty.easy ?? 0, "sage"],
          ["认真", stats.byDifficulty.medium ?? 0, "blue"],
          ["高难", stats.byDifficulty.hard ?? 0, "plum"]
        ]} />
      </section>
      <section className="section-block">
        <SectionHeading title="成就收藏" copy={`${achievements.data?.filter((item) => item.unlocks?.length).length ?? 0} / ${achievements.data?.length ?? 0} 已解锁`} />
        <div className="achievement-grid">
          {achievements.data?.map((item) => {
            const unlocked = Boolean(item.unlocks?.length);
            return (
              <article className={`achievement-card ${unlocked ? "achievement-card--unlocked" : ""}`} key={item.id}>
                <div>{unlocked ? <Award /> : <LockKeyhole />}</div>
                <span>{unlocked ? "已解锁" : `${item.threshold} ${achievementUnit(item.category)}`}</span>
                <h3>{item.name}</h3>
                <p>{item.description}</p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function achievementUnit(category: string) {
  return ["streak", "active_days"].includes(category) ? "天" : category === "earned" ? "积分" : "次";
}

function StatCard({ icon, label, value, suffix }: { icon: ReactNode; label: string; value: number; suffix: string }) {
  return <article className="stat-card"><span>{icon}</span><p>{label}</p><strong>{value}<em>{suffix}</em></strong></article>;
}

function Breakdown({ title, values }: { title: string; values: Array<[string, number, string]> }) {
  const max = Math.max(...values.map((item) => item[1]), 1);
  return (
    <article className="breakdown">
      <h2>{title}</h2>
      {values.map(([label, value, tone]) => (
        <div className="breakdown-row" key={label}>
          <span>{label}</span>
          <div><i className={tone} style={{ width: `${Math.max(4, (value / max) * 100)}%` }} /></div>
          <strong>{value}</strong>
        </div>
      ))}
    </article>
  );
}

const historyScopeCopy: Record<string, string> = {
  all: "按真正发生的事情汇总；任务结算与兑换扣分只出现一次，不与积分账本重复。",
  tasks: "只看任务的最终结果。对应的奖励或扣分可在“积分”账本逐笔核对。",
  points: "完整积分账本。这里的每一行，都是一笔真实影响余额的收支。",
  redemptions: "只看兑换成本与履行状态；积分会在提交兑换时立即扣除。",
  audit: "安全与管理操作记录，用来追溯谁做了什么，不参与余额计算。"
};

const summarizedLedgerTypes = new Set(["task_reward", "task_penalty", "redemption"]);

function HistoryPage({ aiLabel }: { aiLabel: string }) {
  const [kind, setKind] = useState("all");
  const { data, loading, error, refresh } = useLoad<any>(() => api(`/history?kind=${kind}&limit=100`), [kind]);
  const events = useMemo(() => {
    if (!data) return [];
    if (kind === "points") return (data.points ?? []).map((item: any) => ({ ...item, eventKind: "points", date: item.createdAt }));
    if (kind === "tasks") return (data.tasks ?? []).map((item: any) => ({ ...item, eventKind: "tasks", date: item.updatedAt }));
    if (kind === "redemptions") return (data.redemptions ?? []).map((item: any) => ({ ...item, eventKind: "redemptions", date: item.redeemedAt }));
    if (kind === "audit") return (data.audit ?? []).map((item: any) => ({ ...item, eventKind: "audit", date: item.createdAt }));
    return [
      ...(data.points ?? [])
        .filter((item: any) => !summarizedLedgerTypes.has(item.type))
        .map((item: any) => ({ ...item, eventKind: "points", date: item.createdAt })),
      ...(data.tasks ?? []).map((item: any) => ({ ...item, eventKind: "tasks", date: item.updatedAt })),
      ...(data.redemptions ?? []).map((item: any) => ({ ...item, eventKind: "redemptions", date: item.redeemedAt }))
    ].sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 100);
  }, [data, kind]);
  return (
    <div className="page">
      <PageHeader eyebrow="HISTORY" title="每一次发生，都有迹可循" copy="积分不会被悄悄改写，任务也不会无声消失。这里保留完整的时间线。" />
      <div className="segmented segmented--standalone">
        {[["all", "总览"], ["tasks", "任务"], ["points", "积分"], ["redemptions", "兑换"], ["audit", "审计"]].map(([value, label]) =>
          <button key={value} className={kind === value ? "active" : ""} onClick={() => setKind(value)}>{label}</button>
        )}
      </div>
      <p className="history-scope-note"><ShieldCheck size={15} />{historyScopeCopy[kind]}</p>
      {loading ? <PageLoader compact /> : error ? <PageError message={error} retry={refresh} /> : (
        <div className="timeline">
          {events.length ? events.map((event: any, index: number) => <TimelineEvent key={`${event.eventKind}-${event.id}-${index}`} event={event} aiLabel={aiLabel} />) :
            <EmptyState icon={<History />} title="时间线还是空的" copy="完成任务、获得积分或兑换奖励后，记录会出现在这里。" />}
        </div>
      )}
    </div>
  );
}

function TimelineEvent({ event, aiLabel }: { event: any; aiLabel: string }) {
  let icon: ReactNode = <Sparkles />;
  let kindLabel = "记录";
  let title = "记录";
  let copy = "";
  let amount: number | null = null;
  if (event.eventKind === "tasks") {
    icon = event.status === "completed" ? <Check /> : <ListTodo />;
    kindLabel = "任务";
    title = event.title;
    const status = statusLabel[event.status as keyof typeof statusLabel] ?? event.status;
    copy = event.status === "completed"
      ? `${typeLabel[event.type as keyof typeof typeLabel] ?? "任务"} · ${status} · 奖励已记入积分`
      : `${status} · 扣分如有，已记入积分账本`;
    if (event.status === "completed") amount = pointsFor(event);
  } else if (event.eventKind === "points") {
    icon = <Coins />;
    kindLabel = "积分";
    title = ledgerLabel(event.type);
    amount = event.amount;
    copy = formatLedgerReason(event.reason);
  } else if (event.eventKind === "redemptions") {
    icon = <Gift />;
    kindLabel = "兑换";
    title = presentRewardSnapshot(event.itemNameSnapshot, aiLabel);
    copy = event.status === "fulfilled"
      ? `已履行 · 兑换时已扣除 ${event.costSnapshot} 积分`
      : event.status === "cancelled"
        ? "已取消"
        : `等待履行 · 已扣除 ${event.costSnapshot} 积分`;
    amount = -event.costSnapshot;
  } else {
    icon = <ShieldCheck />;
    kindLabel = "审计";
    title = auditActionLabel(event.action);
    copy = `${auditActorLabel(event.actor, aiLabel)} · ${auditEntityLabel(event.entityType)}`;
  }
  return (
    <article className="timeline-event">
      <div className="timeline-event__icon">{icon}</div>
      <div className="timeline-event__content">
        <div className="timeline-event__meta"><span>{formatDate(event.date, true)}</span><em>{kindLabel}</em></div>
        <h3>{title}</h3>
        <p>{copy}</p>
      </div>
      {amount != null && <strong className={amount >= 0 ? "positive" : "negative"}>{amount >= 0 ? "+" : ""}{amount}</strong>}
    </article>
  );
}

function formatLedgerReason(reason = "") {
  if (reason.startsWith("Completed: ")) return `完成任务：${reason.slice("Completed: ".length)}`;
  if (reason.startsWith("Redeemed: ")) return `兑换：${reason.slice("Redeemed: ".length)}`;
  const streak = reason.match(/^Day (\d+) streak bonus$/);
  if (streak) return `第 ${streak[1]} 天连击奖励`;
  if (reason === "Streak bonus recalculated after historical completion") return "历史任务补录后的连击校正";
  if (reason === "Task expired") return "任务逾期";
  return reason || "系统记账";
}

function auditActorLabel(actor: string, aiLabel: string) {
  return actor === "AI" ? aiLabel : actor === "user" ? "用户" : "系统";
}

function auditEntityLabel(entity: string) {
  return {
    task: "任务",
    task_series: "每日任务",
    reward: "奖励",
    redemption: "兑换",
    point_ledger: "积分",
    settings: "设置",
    system: "系统"
  }[entity] ?? "记录";
}

function auditActionLabel(action: string) {
  return {
    "task.created": "创建任务",
    "task.edited": "编辑任务",
    "task.completed": "确认任务完成",
    "task.failed": "判定任务未通过",
    "task.expired": "任务逾期",
    "task.cancelled": "取消任务",
    "task.penalized": "结算任务扣分",
    "task_series.created": "创建每日任务",
    "task_series.resumed": "恢复每日任务",
    "task_series.paused": "暂停每日任务",
    "submission.created": "提交任务证据",
    "submission.rejected": "退回任务证据",
    "reward.created": "创建可兑换奖励",
    "reward.updated": "更新可兑换奖励",
    "reward.archived": "归档可兑换奖励",
    "reward.restored": "恢复可兑换奖励",
    "reward.redeemed": "提交奖励兑换",
    "redemption.fulfilled": "确认奖励已履行",
    "points.bonus": "发放额外积分",
    "points.penalty": "执行额外扣分",
    "points.correction": "校正积分账本",
    "settings.updated": "更新用户设置",
    "system.reconciled": "完成系统日常结算"
  }[action] ?? "系统操作";
}

function ledgerLabel(type: string) {
  return {
    task_reward: "任务奖励",
    streak_bonus: "连击奖励",
    task_penalty: "任务扣分",
    redemption: "兑换消费",
    manual_bonus: "额外奖励",
    manual_penalty: "额外扣分",
    correction: "账本校正"
  }[type] ?? type;
}

function SettingsPage({
  installAvailable,
  installed,
  onInstall,
  onIdentityChanged
}: {
  installAvailable: boolean;
  installed: boolean;
  onInstall: () => Promise<void>;
  onIdentityChanged: (settings: Pick<Bootstrap, "timezone" | "user_label" | "ai_label">) => void;
}) {
  const [tab, setTab] = useState("identity");
  const settings = useLoad<any>(() => api("/settings"), []);
  const tokens = useLoad<any[]>(() => api("/ai-tokens"), []);
  return (
    <div className="page">
      <PageHeader eyebrow="SETTINGS" title="这片空间的规则，由你决定" copy="称呼可以亲密，边界必须清楚。AI 能看见这些规则，但只有你可以修改。" />
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            ["identity", <CircleUserRound />, "称呼与时间"],
            ["boundaries", <ShieldCheck />, "边界与惩罚"],
            ["connection", <KeyRound />, "AI 连接"],
            ["data", <Upload />, "数据与备份"],
            ["security", <LockKeyhole />, "登录安全"]
          ].map(([value, icon, label]) => (
            <button key={value as string} className={tab === value ? "active" : ""} onClick={() => setTab(value as string)}>
              {icon as ReactNode}{label as string}<ChevronRight />
            </button>
          ))}
        </nav>
        <section className="settings-panel">
          {settings.loading ? <PageLoader compact /> : !settings.data ? <PageError message={settings.error} retry={settings.refresh} /> : (
            <>
              {tab === "identity" && (
                <IdentitySettings
                  value={settings.data}
                  onSaved={(updated) => {
                    onIdentityChanged(updated);
                    void settings.refresh();
                  }}
                />
              )}
              {tab === "boundaries" && <BoundarySettings value={settings.data} onSaved={settings.refresh} />}
              {tab === "connection" && <ConnectionSettings tokens={tokens.data ?? []} onChanged={tokens.refresh} />}
              {tab === "data" && (
                <DataSettings
                  installAvailable={installAvailable}
                  installed={installed}
                  onInstall={onInstall}
                />
              )}
              {tab === "security" && <SecuritySettings />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function IdentitySettings({
  value,
  onSaved
}: {
  value: any;
  onSaved: (settings: Pick<Bootstrap, "timezone" | "user_label" | "ai_label">) => void;
}) {
  const [form, setForm] = useState(value);
  return (
    <SettingsForm
      title="称呼与时间"
      copy="显示称呼不改变内部权限。自然日、连击与每日扣分限额都按这里的时区结算。"
      form={form}
      onSave={async () => {
        const updated = await api<any>("/settings", { method: "PUT", body: form });
        onSaved(updated);
      }}
    >
      <div className="field-grid">
        <Field label="你的称呼"><input value={form.user_label} onChange={(e) => setForm({ ...form, user_label: e.target.value })} /></Field>
        <Field label="AI 的称呼"><input value={form.ai_label} onChange={(e) => setForm({ ...form, ai_label: e.target.value })} /></Field>
      </div>
      <Field label="时区" hint="连击、截止时间和每日限额都按这里的自然日结算">
        <TimezoneSelect value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      </Field>
    </SettingsForm>
  );
}

function BoundarySettings({ value, onSaved }: { value: any; onSaved: () => void }) {
  const [form, setForm] = useState(value);
  const [allowed, setAllowed] = useState((value.allowed_content ?? []).join("\n"));
  const [prohibited, setProhibited] = useState((value.prohibited_content ?? []).join("\n"));
  return (
    <SettingsForm
      title="边界与惩罚"
      copy={`边界版本 v${value.boundary_version}。每次修改都会留下审计记录，AI 只能读取，不能代你改动。`}
      form={form}
      onSave={async () => {
        await api("/settings", {
          method: "PUT",
          body: {
            ...form,
            allowed_content: allowed.split("\n").map((x: string) => x.trim()).filter(Boolean),
            prohibited_content: prohibited.split("\n").map((x: string) => x.trim()).filter(Boolean)
          }
        });
        onSaved();
      }}
    >
      <div className="boundary-callout"><ShieldCheck /><div><strong>安全优先于任何任务</strong><span>被禁止的内容不应由 AI 创建；惩罚暂停后，AI 的扣分请求会被服务端拒绝。</span></div></div>
      <div className="field-grid">
        <Field label="允许内容" hint="每行一条"><textarea rows={5} value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="温柔提醒&#10;生活习惯任务" /></Field>
        <Field label="明确禁止" hint="每行一条"><textarea rows={5} value={prohibited} onChange={(e) => setProhibited(e.target.value)} placeholder="危险行为&#10;影响工作或健康的要求" /></Field>
      </div>
      <Field label="补充边界说明"><textarea rows={4} value={form.boundary_notes} onChange={(e) => setForm({ ...form, boundary_notes: e.target.value })} placeholder="写下只有你们需要理解的细节…" /></Field>
      <div className="field-grid">
        <Field label="惩罚强度" hint="0–5"><input type="range" min="0" max="5" value={form.punishment_intensity} onChange={(e) => setForm({ ...form, punishment_intensity: Number(e.target.value) })} /><div className="range-label"><span>关闭</span><strong>{form.punishment_intensity}</strong><span>强</span></div></Field>
        <Field label="每日 AI 扣分上限"><input type="number" min="0" value={form.daily_penalty_limit} onChange={(e) => setForm({ ...form, daily_penalty_limit: Number(e.target.value) })} /></Field>
      </div>
      <label className="switch-row"><div><strong>暂停所有 AI 惩罚</strong><span>系统逾期规则仍按任务约定执行</span></div><input type="checkbox" checked={form.punishments_paused} onChange={(e) => setForm({ ...form, punishments_paused: e.target.checked })} /><i /></label>
    </SettingsForm>
  );
}

function SettingsForm({ title, copy, children, onSave }: { title: string; copy: string; children: ReactNode; form: any; onSave: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try { await onSave(); setMessage("已保存"); } catch (reason) { setMessage(reason instanceof Error ? reason.message : "保存失败"); } finally { setBusy(false); }
  }
  return (
    <form className="settings-form" onSubmit={save}>
      <div className="settings-title"><div><h2>{title}</h2><p>{copy}</p></div>{message && <span>{message}</span>}</div>
      {children}
      <button className="button button--primary"><Save size={17} />{busy ? "保存中…" : "保存更改"}</button>
    </form>
  );
}

function ConnectionSettings({ tokens, onChanged }: { tokens: any[]; onChanged: () => void }) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  async function rotate() {
    if (!confirm("轮换后，所有旧 AI Token 会立即失效。继续吗？")) return;
    setBusy(true);
    try {
      const result = await api<{ token: string }>("/ai-tokens/rotate", { method: "POST", body: { name: "Primary AI" } });
      setSecret(result.token);
      onChanged();
    } finally { setBusy(false); }
  }
  return (
    <div className="settings-form">
      <div className="settings-title"><div><h2>AI 连接</h2><p>将 MCP 地址和 Token 填入支持 Streamable HTTP 的 AI 客户端。</p></div></div>
      <div className="connection-card">
        <span>MCP ENDPOINT</span>
        <SecretBox value={`${location.origin}/mcp`} />
        <p>认证方式：<code>Authorization: Bearer YOUR_AI_TOKEN</code>（推荐），也支持 <code>X-Phosphene-MCP-Token: YOUR_AI_TOKEN</code></p>
      </div>
      {secret && <div className="one-time-secret"><strong>新的 Token 只显示这一次</strong><SecretBox value={secret} /></div>}
      <div className="token-list">
        {tokens.map((token) => (
          <div key={token.id}><span className={token.revokedAt ? "offline" : "online"} /><div><strong>{token.name}</strong><small>{token.revokedAt ? "已撤销" : token.lastUsedAt ? `最近使用 ${formatDate(token.lastUsedAt, true)}` : "尚未使用"}</small></div><code>{token.id.slice(-8)}</code></div>
        ))}
      </div>
      <button className="button button--secondary" onClick={rotate} disabled={busy}><RotateCw size={17} />{busy ? "轮换中…" : "轮换 AI Token"}</button>
      <div className="tool-count"><Sparkles /><div><strong>精简为恰好 7 个工具</strong><span>创建、查询、管理任务，概览、历史、奖励和积分调整。</span></div></div>
    </div>
  );
}

function DataSettings({
  installAvailable,
  installed,
  onInstall
}: {
  installAvailable: boolean;
  installed: boolean;
  onInstall: () => Promise<void>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function restore() {
    if (!file || !password) {
      setMessage("请选择备份并输入当前密码。");
      return;
    }
    if (!confirm("恢复会替换当前任务、积分、兑换、历史和图片。建议先导出当前备份。确定继续吗？")) return;
    setBusy(true);
    setMessage("");
    const form = new FormData();
    form.set("backup", file);
    form.set("password", password);
    try {
      await api("/backup/restore", { method: "POST", body: form });
      setMessage("恢复完成，页面即将刷新。");
      setTimeout(() => location.reload(), 1200);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "恢复失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-form">
      <div className="settings-title"><div><h2>数据与备份</h2><p>导出包含数据库记录和经过净化的私有图片。恢复操作需要再次验证密码。</p></div></div>
      <div className="install-card">
        <div className="install-card__icon"><Download /></div>
        <div>
          <strong>{installed ? "Phosphene 已在桌面" : "把 Phosphene 留在桌面"}</strong>
          <span>
            {installed
              ? "现在可以像独立应用一样打开，并使用完整的移动端安全区。"
              : installAvailable
                ? "安装后会以独立窗口打开，不需要应用商店。"
                : "在浏览器分享或菜单中选择“添加到主屏幕”即可安装。"}
          </span>
        </div>
        {installAvailable && !installed && (
          <button className="button button--secondary" type="button" onClick={() => void onInstall()}>
            安装应用
          </button>
        )}
        {installed && <span className="install-card__status"><Check /> 已安装</span>}
      </div>
      <div className="data-action">
        <div><Upload /><div><strong>导出完整备份</strong><span>下载一个可恢复的 .zip 文件</span></div></div>
        <a className="button button--secondary" href="/api/backup/export" download>开始导出</a>
      </div>
      <div className="data-action data-action--warning">
        <div><RotateCw /><div><strong>从备份恢复</strong><span>会替换当前任务、积分和图片数据</span></div></div>
        <label className="button button--ghost">{file ? file.name : "选择备份"}<input hidden type="file" accept=".zip,application/zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
      </div>
      {file && (
        <div className="restore-confirm">
          <Field label="当前登录密码" hint="用于确认恢复权限">
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <button className="button button--primary" onClick={restore} disabled={busy}>
            <RotateCw size={17} />{busy ? "正在恢复…" : "验证并恢复"}
          </button>
        </div>
      )}
      {message && <div className="notice-banner">{message}</div>}
      <p className="security-note"><ShieldCheck size={15} /> 建议定期下载完整备份，并为 Zeabur 的 /data 持久卷创建快照。</p>
    </div>
  );
}

function SecuritySettings() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/password", { method: "PUT", body: { current_password: current, new_password: next } });
      setMessage("密码已更新。所有会话已退出，请重新登录。");
      setTimeout(() => location.reload(), 1200);
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : "修改失败"); }
  }
  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-title"><div><h2>登录安全</h2><p>更改密码会撤销所有设备上的网站会话，但不会轮换 AI Token。</p></div></div>
      {message && <div className="notice-banner">{message}</div>}
      <Field label="当前密码"><input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
      <Field label="新密码" hint="至少 10 个字符"><input type="password" minLength={10} required value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      <button className="button button--primary"><LockKeyhole size={17} />更新密码</button>
    </form>
  );
}

function SecretBox({ value }: { value: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }
  return (
    <div className="secret-box">
      <code>{visible ? value : "•".repeat(Math.min(42, value.length))}</code>
      <button onClick={() => setVisible(!visible)} type="button" aria-label="显示或隐藏">{visible ? <EyeOff /> : <Eye />}</button>
      <button onClick={copy} type="button" aria-label="复制">{copied ? <Check /> : <Copy />}</button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>{children}</label>;
}

function TimezoneSelect({
  value,
  onChange
}: {
  value: string;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  const legacyValue = !supportedTimezoneValues.has(value);
  return (
    <select required value={value} onChange={onChange}>
      {legacyValue && <option value={value}>当前旧时区 · {value}</option>}
      {TIMEZONE_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function InlineError({ message }: { message: string }) {
  return <div className="inline-error">{message}</div>;
}

function PageLoader({ compact = false }: { compact?: boolean }) {
  return <div className={`page-loader ${compact ? "page-loader--compact" : ""}`}><span /><p>正在整理这里的光点…</p></div>;
}

function PageError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="page-error"><MoonStar /><h2>这里暂时没有亮起来</h2><p>{message}</p><button className="button button--secondary" onClick={retry}>再试一次</button></div>;
}

function EmptyState({ icon, title, copy, compact = false }: { icon: ReactNode; title: string; copy: string; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "empty-state--compact" : ""}`}><span>{icon}</span><h3>{title}</h3><p>{copy}</p></div>;
}

export default function App() {
  const [state, setState] = useState<"loading" | "setup" | "login" | "ready">("loading");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia?.("(display-mode: standalone)").matches ?? false
  );
  useEffect(() => {
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);
  useEffect(() => {
    void (async () => {
      try {
        const data = await api<Bootstrap>("/bootstrap");
        setBootstrap(data);
        if (!data.initialized) {
          setState("setup");
          return;
        }
        try {
          await api("/me");
          setState("ready");
        } catch {
          setState("login");
        }
      } catch {
        setState("login");
      }
    })();
  }, []);
  async function doLogout() {
    try { await api("/logout", { method: "POST" }); } finally { setState("login"); }
  }
  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallPrompt(null);
  }
  if (state === "loading") return <FullPageLoader />;
  if (state === "setup") {
    return (
      <SetupPage
        setupProtected={bootstrap?.setup_protected ?? false}
        onReady={(data) => {
          setBootstrap(data);
          setState("ready");
        }}
      />
    );
  }
  if (state === "login") return <LoginPage onLogin={() => setState("ready")} />;
  const readyBootstrap = bootstrap ?? {
    initialized: true,
    setup_protected: false,
    timezone: "Asia/Shanghai",
    user_label: "你",
    ai_label: "AI"
  };
  return (
    <AppShell
      bootstrap={readyBootstrap}
      installPrompt={installPrompt}
      installed={installed}
      onInstall={installApp}
      onIdentityChanged={(settings) => setBootstrap((current) => ({ ...(current ?? readyBootstrap), ...settings }))}
      onLogout={doLogout}
    />
  );
}
