from pathlib import Path
import subprocess,json
root=Path('/Users/jahonshoh/Health-AI')
out=Path('/private/tmp/health-ai-db-audit.0xe3j2')
base=['psql','-X','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1']
def run(file,txn=True):
    r=subprocess.run(base+(['-1'] if txn else [])+['-f',str(file)],capture_output=True,text=True)
    return {'file':file.name,'exit':r.returncode,'errors':r.stderr[-4500:] if r.returncode else ''}
results=[run(out/'bootstrap.sql')]
for f in sorted((root/'supabase/migrations').glob('*.sql')):
    r=run(f);results.append(r)
    if r['exit']:
        print(json.dumps(r));break
print('Migration files passed:',sum(r['exit']==0 for r in results)-1)
(out/'replay-results.json').write_text(json.dumps(results,indent=2))
