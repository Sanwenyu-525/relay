/**
 * `gh` 子进程的环境白名单——唯一一份。
 *
 * 不继承 `process.env`：那样会把 Relay 进程里的一切（包括它可能见过的 token）带进
 * 一个会访问网络的子进程。这里只给「Windows 定位」「`gh` 找到自己的凭据存储」
 * 「走代理」这几项必需的键：
 *
 * - `APPDATA` / `LOCALAPPDATA`：Windows 上 `gh` 的登录凭据在
 *   `%APPDATA%\GitHub CLI\hosts.yml`。缺了这两项，`gh` 连自己的凭据文件都看不到
 *   （`gh auth status` 会直接说「没有登录到任何 GitHub 主机」）。
 *   2026-10-21 实测（gh 2.102.0，隔离的临时 APPDATA）：带上 APPDATA 时 gh 能读出
 *   凭据文件里的账号，去掉后它说「没有登录」——键在不在，决定「能不能读到自己」。
 *   因此**插件状态探测与实际适配器必须共用这一份白名单**，否则界面报「未登录」
 *   而实际链路可用。
 * - `USERPROFILE` / `HOME`：`gh` 配置目录的回退位置。
 * - `GH_PROMPT_DISABLED`：缺权限时直接失败，不挂在交互提示上。
 */
export function githubEnv(): NodeJS.ProcessEnv {
  const source = process.env;
  return {
    SYSTEMROOT: source.SYSTEMROOT ?? '', SYSTEMDRIVE: source.SYSTEMDRIVE ?? '',
    WINDIR: source.WINDIR ?? '', PATH: source.PATH ?? '', PATHEXT: source.PATHEXT ?? '',
    TEMP: source.TEMP ?? '', TMP: source.TMP ?? '',
    USERPROFILE: source.USERPROFILE ?? '', HOME: source.USERPROFILE ?? source.HOME ?? '',
    APPDATA: source.APPDATA ?? '', LOCALAPPDATA: source.LOCALAPPDATA ?? '',
    HTTP_PROXY: source.HTTP_PROXY, HTTPS_PROXY: source.HTTPS_PROXY, NO_PROXY: source.NO_PROXY,
    http_proxy: source.http_proxy, https_proxy: source.https_proxy, no_proxy: source.no_proxy,
    GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
  };
}
