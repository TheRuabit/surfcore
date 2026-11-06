/**
 * 斜杠命令文本解析（纯函数）。
 *
 * 群内 "@机器人 /命令" 是通行证，裸 "/命令" 一律丢弃；私聊不需要 @。
 * 判定只做文本层，消息段的切分由调用方完成（见 leadingSelfAtCount）。
 */

/**
 * 数出开头连续的「@自己」消息段，返回切分点。
 *
 * 只有 at 目标是自己、或中间的纯空白 text 段会被跳过；@别人 / @全体 立刻停止，
 * 因为它们不构成「在对机器人下命令」。
 *
 * @param {Array} segments OneBot 消息段
 * @param {string} selfUserId 机器人自己的 QQ 号
 * @returns {{count:number, end:number}} end 是要保留内容的起始下标
 */
export function leadingSelfAtCount(segments, selfUserId) {
  const list = Array.isArray(segments) ? segments : [];
  const self = String(selfUserId ?? '');
  let count = 0;
  let i = 0;
  for (; i < list.length; i += 1) {
    const seg = list[i];
    const type = seg?.type;
    if (type === 'at' && self && String(seg?.data?.qq ?? '') === self) { count += 1; continue; }
    if (type === 'text' && !String(seg?.data?.text ?? '').trim()) continue;
    break;
  }
  return { count, end: i };
}

/**
 * 判定一条消息是不是斜杠命令。
 *
 * - 私聊：以 "/" 开头即命令（私聊天然指向机器人，Q7）。
 * - 群聊：剥掉前导 @机器人 后以 "/" 开头才是命令；没剥就直接以 "/" 开头属于裸斜杠，
 *   丢弃并留痕（Q1/Q8），不投给 DSH。
 * - 群聊里 @别人 / @全体 打头的消息不是命令，照常走对话。
 *
 * @param {{plainContent?:string, tailContent?:string, hadAtPrefix?:boolean, kind?:string}} input
 * @returns {{isCommand:boolean, droppedBare:boolean, hadAtPrefix:boolean, commandText:string}}
 */
export function resolveCommandText({ plainContent, tailContent, hadAtPrefix = false, kind = 'group' } = {}) {
  const plain = String(plainContent ?? '').trim();
  const tail = String(tailContent ?? plain).trim();
  const plainIsSlash = plain.startsWith('/');
  if (kind === 'private') {
    return {
      isCommand: plainIsSlash,
      droppedBare: false,
      hadAtPrefix: false,
      commandText: plainIsSlash ? plain : '',
    };
  }
  if (hadAtPrefix && tail.startsWith('/')) {
    return { isCommand: true, droppedBare: false, hadAtPrefix: true, commandText: tail };
  }
  if (plainIsSlash) {
    return { isCommand: false, droppedBare: true, hadAtPrefix: false, commandText: '' };
  }
  return { isCommand: false, droppedBare: false, hadAtPrefix: false, commandText: '' };
}
