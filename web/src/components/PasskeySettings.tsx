import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import type { PasskeyView } from "../api.ts";
import { loadPasskeys, passkeyStatus, registerPasskey, removePasskey } from "../store.ts";

export function PasskeySettings() {
  const [keys, setKeys] = useState<PasskeyView[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function report(failure: unknown) {
    setError(failure instanceof Error ? failure.message : String(failure));
  }

  useEffect(() => {
    void Promise.all([loadPasskeys(), passkeyStatus()]).then(([list, status]) => {
      setKeys(list);
      setEnabled(status.enabled && browserSupportsWebAuthn());
    }, report);
  }, []);

  async function change(id?: string) {
    setBusy(true);
    setError("");
    try {
      if (id) {
        await removePasskey(id, password);
        setKeys((current) => current?.filter((key) => key.id !== id) ?? []);
      } else {
        const key = await registerPasskey(password, name.trim());
        setKeys((current) => [...(current ?? []), key]);
        setName("");
      }
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  return (
    <div className="formcard">
      <div className="lbl">{t("通行密钥")}</div>
      {keys?.map((key) => (
        <div className="sfoot" key={key.id}>
          <span>{key.name}</span>
          <span className="note">{key.rpId}</span>
          <span className="sp" />
          <button className="hob-btn" type="button" disabled={busy || !password} onClick={() => void change(key.id)}>
            {t("移除")}
          </button>
        </div>
      ))}
      {keys && !enabled ? <div className="note">{t("添加通行密钥需要支持 WebAuthn 的浏览器，以及配置的 HTTPS 地址或本机 localhost。")}</div> : null}
      {keys && (enabled || keys.length > 0) ? (
        <>
          <div className="note">{t("添加或移除通行密钥时，请输入当前登录密码。")}</div>
          {enabled ? (
            <label className="field">
              <input value={name} maxLength={80} placeholder={t("通行密钥名称")} aria-label={t("通行密钥名称")} onChange={(event) => setName(event.target.value)} />
            </label>
          ) : null}
          <label className="field">
            <input type="password" autoComplete="current-password" value={password} placeholder={t("旧密码")} aria-label={t("旧密码")} onChange={(event) => setPassword(event.target.value)} />
          </label>
          {enabled ? (
            <div className="sfoot">
              <button className="hob-btn" type="button" disabled={busy || !password || !name.trim()} onClick={() => void change()}>
                {t("添加通行密钥")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <span className="badline" role="status">{error}</span> : null}
    </div>
  );
}
