// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/web/App";
import { PasswordRecovery, RecoverySettings } from "../src/web/Recovery";
import { api } from "../src/web/api";

vi.mock("../src/web/api", () => ({ api: vi.fn(), idempotencyKey: vi.fn() }));
const mockedApi = vi.mocked(api);
const bootstrap = { initialized: false, setup_protected: false, timezone: "Asia/Shanghai", user_label: "你", ai_label: "AI" };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const fill = (name: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });

async function startSetup() {
  mockedApi.mockImplementation(async (path) => path === "/bootstrap" ? bootstrap : { ai_token: "test-token" });
  render(<MemoryRouter><App /></MemoryRouter>);
  await screen.findByLabelText(/登录密码/);
  fill(/登录密码/, "0123456789");
  fill("再次输入密码", "0123456789");
  fireEvent.click(screen.getByRole("button", { name: "继续" }));
}

describe("simple optional recovery UI", () => {
  it("can skip recovery even after entering an incomplete draft", async () => {
    await startSetup();
    fill("密保问题", "我的生日？");
    fireEvent.click(screen.getByRole("button", { name: "暂时跳过" }));
    fireEvent.click(screen.getByRole("button", { name: /完成设置/ }));
    await screen.findByText("收好这把钥匙");
    const setupCall = mockedApi.mock.calls.find(([path]) => path === "/setup");
    expect(setupCall?.[1]?.body).not.toHaveProperty("recovery");
  });

  it("accepts a short Chinese answer and waits until final setup to save it", async () => {
    await startSetup();
    const answerInput = screen.getByLabelText("密保答案") as HTMLInputElement;
    const confirmInput = screen.getByLabelText("再次输入密保答案") as HTMLInputElement;
    expect(answerInput.type).toBe("text");
    expect(confirmInput.type).toBe("text");
    fill("密保问题", "名字？");
    fireEvent.compositionStart(answerInput);
    fill("密保答案", "小明");
    fireEvent.compositionEnd(answerInput, { data: "小明" });
    expect(answerInput.value).toBe("小明");
    fill("再次输入密保答案", "小红");
    fireEvent.click(screen.getByRole("button", { name: /保存密保并继续/ }));
    expect(screen.getByRole("alert").textContent).toContain("不一致");
    fill("再次输入密保答案", "小明");
    fireEvent.click(screen.getByRole("button", { name: /保存密保并继续/ }));
    expect(mockedApi.mock.calls.some(([path]) => path === "/setup")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /完成设置/ }));
    await screen.findByText("收好这把钥匙");
    expect(mockedApi.mock.calls.find(([path]) => path === "/setup")?.[1]?.body).toMatchObject({ recovery: { question: "名字？", answer: "小明" } });
  });

  it("does not allow Enter on an earlier step to initialize the account", async () => {
    await startSetup();
    fireEvent.submit(screen.getByLabelText("密保问题").closest("form")!);
    expect(screen.getByRole("alert").textContent).toContain("请输入密保问题");
    expect(mockedApi.mock.calls.some(([path]) => path === "/setup")).toBe(false);
  });

  it("explains when recovery is unavailable and offers a way back", async () => {
    mockedApi.mockResolvedValue({ enabled: false, question: null });
    const onBack = vi.fn();
    render(<PasswordRecovery onBack={onBack} onRecovered={vi.fn()} />);
    expect(await screen.findByText(/此实例没有设置密保/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重置密码" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回登录" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("validates confirmation, displays answer errors, and completes a reset", async () => {
    mockedApi.mockResolvedValueOnce({ enabled: true, question: "我的生日？" })
      .mockRejectedValueOnce(new Error("密保答案不正确，请检查大小写后重试。"))
      .mockResolvedValueOnce({ login_required: true });
    const onRecovered = vi.fn();
    render(<PasswordRecovery onBack={vi.fn()} onRecovered={onRecovered} />);
    await screen.findByText("我的生日？");
    expect((screen.getByLabelText("密保答案") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText(/新密码.*10/) as HTMLInputElement).type).toBe("password");
    fill("密保答案", "0101");
    fill(/新密码.*10/, "abcdefghij");
    fill("再次输入新密码", "abcdefghik");
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    expect(screen.getByRole("alert").textContent).toContain("不一致");
    expect(mockedApi).toHaveBeenCalledTimes(1);
    fill("再次输入新密码", "abcdefghij");
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await screen.findByText(/密保答案不正确/);
    fireEvent.click(screen.getByRole("button", { name: "重置密码" }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
    expect(mockedApi).toHaveBeenLastCalledWith("/recovery/reset", { method: "POST", body: { answer: "0101", new_password: "abcdefghij" } });
  });

  it("lets existing users add and disable recovery without displaying saved answers", async () => {
    mockedApi.mockResolvedValueOnce({ enabled: false, question: null })
      .mockResolvedValueOnce({ enabled: true, question: "名字？" })
      .mockResolvedValueOnce({ enabled: false, question: null });
    render(<RecoverySettings />);
    await screen.findByLabelText("密保问题");
    expect((screen.getByLabelText("密保答案") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("再次输入密保答案") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("确认当前密码") as HTMLInputElement).type).toBe("password");
    fill("密保问题", "名字？");
    fill("密保答案", "小明");
    fill("再次输入密保答案", "小明");
    fill("确认当前密码", "current-password");
    fireEvent.click(screen.getByRole("button", { name: "保存密保" }));
    await screen.findByText(/密保已保存/);
    expect((screen.getByLabelText("密保答案") as HTMLInputElement).value).toBe("");
    fill("确认当前密码", "current-password");
    fireEvent.click(screen.getByRole("button", { name: "停用密保" }));
    await screen.findByText(/密保已停用/);
    expect(mockedApi).toHaveBeenLastCalledWith("/recovery", { method: "PUT", body: { current_password: "current-password", recovery: null } });
  });
});
