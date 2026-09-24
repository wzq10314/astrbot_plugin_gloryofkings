"""Stage a reviewed upstream snapshot without modifying the installed adapter or its data."""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile

REPOSITORY='https://gitee.com/longhengmu/GloryOfKings-Plugin'
ROOT=Path(__file__).resolve().parents[1]


def git(checkout,*args):
    return subprocess.check_output(['git','-c',f'safe.directory={checkout}', '-C',str(checkout),*args])


def stage(checkout,destination):
    checkout=checkout.resolve();destination=destination.resolve()
    origin=git(checkout,'remote','get-url','origin').decode().strip()
    parsed=urlsplit(origin)
    if parsed.scheme!='https' or parsed.hostname!='gitee.com' or parsed.path.rstrip('/').removesuffix('.git')!='/longhengmu/GloryOfKings-Plugin':
        raise ValueError('origin 不是指定的 longhengmu/GloryOfKings-Plugin HTTPS 仓库。')
    if git(checkout,'status','--porcelain').strip():
        raise ValueError('请使用干净的上游检出目录。')
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('候选目录必须为空，避免覆盖已有工作。')
    commit=git(checkout,'rev-parse','HEAD').decode().strip()
    archive=git(checkout,'archive','--format=zip',commit)
    files={}
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        for info in zipped.infolist():
            if info.is_dir():continue
            path=PurePosixPath(info.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in info.filename or stat.S_ISLNK(info.external_attr>>16):
                raise ValueError('上游含不支持的文件路径或符号链接。')
            if path.parts[0] in {'.git','data','node_modules','server','server-im','local'} or info.filename.startswith('config/config/'):
                raise ValueError('上游开始跟踪运行数据/私人扩展，请人工审查。')
            content=zipped.read(info)
            target=destination/'engine/upstream'/info.filename
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
            files[info.filename]=hashlib.sha256(content).hexdigest()
    previous=json.loads((ROOT/'UPSTREAM.json').read_text(encoding='utf-8'))
    package=json.loads((destination/'engine/upstream/package.json').read_text(encoding='utf-8'))
    manifest={'repository':REPOSITORY,'branch':'master','commit':commit,'version':package.get('version'),
              'retrieved_at':datetime.now(timezone.utc).isoformat(),'files':dict(sorted(files.items()))}
    (destination/'UPSTREAM.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    old=previous['files']
    changes={'from':previous['commit'],'to':commit,'added':sorted(set(files)-set(old)),
             'modified':sorted(k for k in files.keys()&old.keys() if files[k]!=old[k]),'deleted':sorted(set(old)-set(files))}
    (destination/'CHANGES.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:len(v) if isinstance(v,list) else v for k,v in changes.items()},ensure_ascii=False))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checkout',type=Path)
    parser.add_argument('--stage',required=True,type=Path)
    args=parser.parse_args()
    if args.checkout:stage(args.checkout,args.stage)
    else:
        with tempfile.TemporaryDirectory(prefix='gok-upstream-') as temp:
            checkout=Path(temp)/'source'
            subprocess.run(['git','clone','--depth','1','--branch','master',REPOSITORY+'.git',str(checkout)],check=True)
            stage(checkout,args.stage)

if __name__=='__main__':main()
