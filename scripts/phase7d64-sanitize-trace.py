import json, re, sys, zipfile

def clean(value):
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, dict):
        if str(value.get('name', '')).lower() in ('authorization', 'cookie', 'set-cookie', 'apikey'):
            return {**value, 'value': '[REDACTED]'}
        return {k: ('[REDACTED]' if k in ('access_token', 'refresh_token', 'ticket', 'password') else clean(v)) for k,v in value.items()}
    if isinstance(value, str):
        if value.lstrip().startswith(('{', '[')):
            try: return json.dumps(clean(json.loads(value)))
            except (ValueError, TypeError): pass
        value = re.sub(r'([?&]ticket=)[^&"\s]+', r'\1[REDACTED]', value)
        value = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_JWT]', value)
    return value

with zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as dst:
    for info in src.infolist():
        data = src.read(info.filename)
        try:
            text = data.decode('utf-8')
            lines = []
            for line in text.splitlines():
                try: lines.append(json.dumps(clean(json.loads(line))))
                except (ValueError, TypeError): lines.append(clean(line))
            data = '\n'.join(lines).encode()
        except UnicodeDecodeError:
            pass
        dst.writestr(info.filename, data)
