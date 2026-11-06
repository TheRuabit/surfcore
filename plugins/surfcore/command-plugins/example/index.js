/**
 * 示例命令插件：只验证接口，不包含任何业务。
 *
 * 开启方式：SurfCore 设置 → Log Terminal → 启用「命令插件示例」。
 * 成功命令会回复 QQ；权限/未知/异常等失败只进日志。
 */
export async function activate(api) {
  api.commands.register({
    name: '回声',
    aliases: ['echo', 'ping'],
    permission: 'user',
    scopes: ['group', 'private'],
    description: '回显参数，验证命令接口',
    async handler(_ctx, args) {
      return { text: args ? `接口正常：${args}` : '接口正常。' };
    },
  });

  api.commands.register({
    name: '插件状态',
    aliases: ['plugin-status'],
    permission: 'admin',
    scopes: ['group', 'private'],
    description: '查看示例插件状态（仅管理员）',
    async handler() {
      // 不回显 api.dataDir：QQ 是公共通道，本机绝对路径属于敏感信息。
      // 要看路径去设置 → Log Terminal 的插件卡片。
      return { text: 'example 插件运行中。' };
    },
  });
}
