import { type FormEvent, useEffect, useState } from "react";
import {
  RECOVERY_ANSWER_HINT, RECOVERY_NOTICE, recoveryQuestionSchema, type RecoveryStatus
} from "../shared/recovery";
import { PASSWORD_REQUIREMENTS, resetPasswordSchema } from "../shared/schemas";
import { api } from "./api";

export type RecoveryDraft = { question: string; answer: string; confirm: string };
export const emptyRecoveryDraft: RecoveryDraft = { question: "", answer: "", confirm: "" };

export function recoveryDraftError(value: RecoveryDraft) {
  const result = recoveryQuestionSchema.safeParse(value);
  if (!result.success) return result.error.issues[0].message;
  return value.answer.trim() === value.confirm.trim() ? "" : "两次输入的密保答案不一致。";
}

export function RecoveryFields({ value, onChange }: { value: RecoveryDraft; onChange: (value: RecoveryDraft) => void }) {
  return <>
    <label className="field"><span><strong>密保问题</strong></span>
      <input required maxLength={200} value={value.question} onChange={(e) => onChange({ ...value, question: e.target.value })} placeholder="写一个你记得答案的问题" />
    </label>
    <label className="field"><span><strong>密保答案</strong></span>
      <input required type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} value={value.answer} onChange={(e) => onChange({ ...value, answer: e.target.value })} aria-describedby="recovery-answer-hint" />
    </label>
    <p className="muted" id="recovery-answer-hint">{RECOVERY_ANSWER_HINT}</p>
    <label className="field"><span><strong>再次输入密保答案</strong></span>
      <input required type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} value={value.confirm} onChange={(e) => onChange({ ...value, confirm: e.target.value })} />
    </label>
    <p className="muted">{RECOVERY_NOTICE} 问题会显示在找回页，答案不会公开。</p>
  </>;
}

export function PasswordRecovery({ onBack, onRecovered }: { onBack: () => void; onRecovered: () => void }) {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  async function load() {
    setLoading(true);
    setError("");
    try { setStatus(await api<RecoveryStatus>("/recovery")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法读取密保问题。"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const result = resetPasswordSchema.safeParse({ answer, new_password: password });
    if (!result.success) { setError(result.error.issues[0].message); return; }
    if (password !== confirm) { setError("两次输入的新密码不一致。"); return; }
    setError("");
    setBusy(true);
    try {
      await api("/recovery/reset", { method: "POST", body: result.data });
      onRecovered();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "密码重置没有完成。"); }
    finally { setBusy(false); }
  }
  return <form className="auth-form" onSubmit={submit}>
    <p className="step-label">找回入口</p>
    <h2>忘记密码</h2>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {loading ? <p className="muted">正在读取密保问题…</p> : status?.enabled ? <>
      <p className="muted">回答设置时保存的问题，然后为这个空间设置新密码。</p>
      <div className="notice-banner recovery-question"><strong>你的密保问题</strong><p>{status.question}</p></div>
      <label className="field"><span><strong>密保答案</strong></span>
        <input autoFocus required type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </label>
      <p className="muted">{RECOVERY_ANSWER_HINT}</p>
      <label className="field"><span><strong>新密码</strong><small>10–256 个字符</small></span>
        <input required type="password" autoComplete="new-password" maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <p className="muted">{PASSWORD_REQUIREMENTS}</p>
      <label className="field"><span><strong>再次输入新密码</strong></span>
        <input required type="password" autoComplete="new-password" maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </label>
      <button className="button button--primary button--wide" disabled={busy}>{busy ? "正在重置…" : "重置密码"}</button>
      <p className="muted">成功后需要重新登录。任务、积分与 AI Token 保持不变。</p>
    </> : status ? <p className="muted">此实例没有设置密保，无法通过密保找回密码。如果还记得原密码，请返回登录；登录后可以在“设置 → 登录安全”中补设。</p>
      : <button type="button" className="button button--secondary" onClick={() => void load()}>重新读取</button>}
    <button type="button" className="button button--ghost button--wide" disabled={busy} onClick={onBack}>返回登录</button>
  </form>;
}

export function RecoverySettings() {
  const [status, setStatus] = useState<RecoveryStatus | null>(null);
  const [draft, setDraft] = useState(emptyRecoveryDraft);
  const [current, setCurrent] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setError("");
    try {
      const result = await api<RecoveryStatus>("/recovery");
      setStatus(result);
      setDraft({ ...emptyRecoveryDraft, question: result.question ?? "" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "暂时无法读取密保设置。"); }
  }
  useEffect(() => { void load(); }, []);
  async function save(enabled: boolean) {
    if (busy) return;
    setMessage("");
    const validation = !current ? "请输入当前密码以确认操作。" : enabled ? recoveryDraftError(draft) : "";
    if (validation) { setError(validation); return; }
    setError("");
    setBusy(true);
    try {
      const result = await api<RecoveryStatus>("/recovery", {
        method: "PUT", body: { current_password: current, recovery: enabled ? { question: draft.question, answer: draft.answer } : null }
      });
      setStatus(result);
      setDraft({ ...emptyRecoveryDraft, question: result.question ?? "" });
      setCurrent("");
      setMessage(enabled ? "密保已保存。忘记密码时可在登录页使用。" : "密保已停用。请妥善保存登录密码。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "密保设置没有保存。"); }
    finally { setBusy(false); }
  }
  return <form className="settings-form recovery-settings" onSubmit={(event) => { event.preventDefault(); void save(true); }}>
    <div className="settings-title"><div><h2>密保找回 · 可选</h2><p>忘记密码时，通过回答自己设置的问题重置密码。不需要配置邮箱。</p></div></div>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {message && <div className="notice-banner" role="status">{message}</div>}
    {status ? <>
      <p className="muted">{status.enabled ? "已设置密保。修改时请重新填写答案，旧答案不会显示。" : "尚未设置密保。不需要时可以留空。"}</p>
      <RecoveryFields value={draft} onChange={setDraft} />
      <label className="field"><span><strong>确认当前密码</strong></span>
        <input required type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <div className="button-row">
        <button className="button button--primary" disabled={busy}>{busy ? "正在保存…" : "保存密保"}</button>
        {status.enabled && <button type="button" className="button button--ghost" disabled={busy} onClick={() => void save(false)}>停用密保</button>}
      </div>
    </> : <button type="button" className="button button--secondary" onClick={() => void load()}>读取密保设置</button>}
  </form>;
}
