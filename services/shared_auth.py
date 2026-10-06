"""Opt-in query authentication across this installation's bot namespaces."""
import json
from pathlib import Path
import re


# Upstream moved these hooks from ApiService to CampAuthSession. Recognize
# complete, known layouts only; a partial or ambiguous match must fail closed.
_STATUS_HOOK_LAYOUTS = (
    ("  #markCandidateAuthFailure(candidate, message = '') {",
     '  #markCandidateAuthSuccess(candidate) {'),
    ("  markFailure (candidate, message = '') {",
     '  markSuccess (candidate) {'),
)


def adapt_shared_query_auth(engine: Path, runtime: Path, settings: dict, data_root: Path):
    namespace = str(settings.get('official_query_auth_namespace') or '').strip()
    if not namespace:
        return False
    if not re.fullmatch(r'[a-f0-9]{20}', namespace):
        raise ValueError('Invalid shared query authentication namespace')
    allowed = settings.get('official_query_auth_accounts', [])
    if not isinstance(allowed, list) or not allowed or any(
        not re.fullmatch(r'\d{5,20}', str(value)) for value in allowed
    ):
        raise ValueError('Shared query authentication requires explicit camp account IDs')
    root = data_root.resolve()
    source = root / namespace / 'runtime/plugins/GloryOfKings-Plugin/data/AuthPool.json'
    # Reject symlinked paths, even if their current target happens to be inside.
    cursor = source
    while cursor != root:
        if cursor.is_symlink():
            raise ValueError('Shared query authentication source must not be a symlink')
        cursor = cursor.parent
    if not source.resolve().is_relative_to(root) or source.resolve().is_relative_to(runtime.resolve()):
        raise ValueError('Invalid shared query authentication source')
    api_file = runtime / 'plugins/GloryOfKings-Plugin/utils/api.js'
    text = api_file.read_text(encoding='utf-8')
    layouts = [hooks for hooks in _STATUS_HOOK_LAYOUTS
               if all(text.count(hook) == 1 for hook in hooks)]
    if len(layouts) != 1 or any(
        text.count(hook) != int(hook in layouts[0])
        for hooks in _STATUS_HOOK_LAYOUTS for hook in hooks
    ):
        raise ValueError('Upstream shared query authentication hook changed')
    replacements = {
        '    const candidates = authStore.getAuthCandidates(targetUserId)':
        '    const localCandidates = authStore.getAuthCandidates(targetUserId)\n'
        '    const candidates = localCandidates.length ? localCandidates : '
        f'readSharedQueryCandidates({json.dumps(str(source))}, {json.dumps([str(x) for x in allowed])})',
    }
    for hook in layouts[0]:
        replacements[hook] = hook + "\n    if (candidate?.source === 'adapter-shared-global') return"
    for before, after in replacements.items():
        if text.count(before) != 1:
            raise ValueError('Upstream shared query authentication hook changed')
        text = text.replace(before, after)
    helper = (engine / 'shared-query-auth.mjs').resolve().as_uri()
    api_file.write_text(f'import {{readSharedQueryCandidates}} from {json.dumps(helper)};\n' + text,
                        encoding='utf-8')
    return True
