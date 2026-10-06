"""Official-only dynamic keyboards on runtime help copies; vendor files stay exact."""
import json
from pathlib import Path


def adapt_help_buttons(engine: Path, runtime: Path):
    helper = (engine / 'help-buttons.mjs').resolve().as_uri()
    file = runtime / 'plugins/GloryOfKings-Plugin/apps/help.js'
    source = file.read_text(encoding='utf-8')
    anchor = '      await e.reply([inventoryImage, Button.help()], shouldQuote())'
    if source.count(anchor) != 1:
        raise ValueError('Upstream official help button hook changed')
    source = source.replace(anchor,
        '      await e.reply([inventoryImage, buildHelpButtons(e, sections, '
        '(...rows) => segment.button(...rows))], shouldQuote())')
    file.write_text(f'import {{buildHelpButtons}} from {json.dumps(helper)};\n' + source,
                    encoding='utf-8')
    return True
