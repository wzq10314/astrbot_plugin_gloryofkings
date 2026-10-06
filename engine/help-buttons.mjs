// Build the official keyboard from the same visible cards as the help image.
// Display metadata is the source; route regular expressions are never commands.
const NEEDS_INPUT = new Set(['#切换营地', '#删除营地', '#王者对比', '#查战力', '#查皮肤']);
const MAIN_HELP = /^#?王者(?:荣耀|农药)?(?:插件|plugin)?(?:帮助|help)\s*$/i;
const COMMAND = /^#[^\s\[\]<>^$|{}()\\]+$/u;

function literalPrefix(args) {
  return args.split(/[\[<@]/u, 1)[0].trim();
}

/** Returns rows of at most two buttons; the transport may paginate these rows. */
export function helpButtonRows(event, sections) {
  const ownerPrivate = Boolean(event?.isMaster && !event?.isGroup);
  const buttons = [], seen = new Set();
  const add = button => {
    const value = button.callback || button.input;
    const key = (button.callback ? 'callback:' : 'input:') + value;
    if (!seen.has(key)) {seen.add(key); buttons.push(button);}
  };
  for (const section of Array.isArray(sections) ? sections : []) {
    if (!section || (section.ownerOnly && !ownerPrivate)) continue;
    for (const item of Array.isArray(section.list) ? section.list : []) {
      if (!item || (item.ownerOnly && !ownerPrivate)) continue;
      const args = typeof item.args === 'string' ? item.args.trim() : '';
      const commands = [item.cmd, ...(Array.isArray(item.alias) ? item.alias : [])];
      for (const raw of commands) {
        if (typeof raw !== 'string') continue;
        const command = raw.trim();
        if (!COMMAND.test(command)) continue;
        if (command === '#查询N战绩') {
          add({text: '按账号序号查战绩', input: '#查询[账号序号]战绩 [对局序号]'});
          continue;
        }
        // Required parameters stay editable, and are never sent as literal placeholders.
        const required = /[<@]/u.test(args) || NEEDS_INPUT.has(command);
        const fixed = literalPrefix(args);
        const prefix = command + (fixed ? ' ' + fixed : '');
        if (required) {
          const syntax = command + (args ? ' ' + args : ' ');
          add({text: prefix.slice(1) + '·填参数', input: syntax});
        } else {
          add({text: prefix.slice(1), callback: prefix});
          if (command === '#绑定营地') {
            add({text: '填写营地ID', input: '#绑定营地 [营地ID]'});
          } else if (args === '[刷新]') {
            add({text: prefix.slice(1) + '·刷新', callback: prefix + ' 刷新'});
          }
        }
      }
    }
  }
  if (!MAIN_HELP.test(String(event?.msg || '').trim())) {
    add({text: '返回王者帮助', callback: '#王者帮助'});
  }
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

export function buildHelpButtons(event, sections, buttonFactory = globalThis.segment?.button) {
  const rows = helpButtonRows(event, sections);
  return typeof buttonFactory === 'function' && rows.length ? buttonFactory(...rows) : null;
}
