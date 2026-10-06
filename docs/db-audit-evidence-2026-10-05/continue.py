from pathlib import Path
import subprocess,json
root=Path('/Users/jahonshoh/Health-AI/supabase/migrations');out=Path('/private/tmp/health-ai-db-audit.0xe3j2')
base=['psql','-X','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1','-1']
def run(p):
 r=subprocess.run(base+['-f',str(p)],capture_output=True,text=True);res={'file':p.name,'exit':r.returncode,'errors':r.stderr[-2500:] if r.returncode else ''};print(json.dumps(res));return res
results=[]
s=(root/'20260822130000_fix_audit_and_multiclinic_rls.sql').read_text().replace('drop function if exists public.handle_audit_log();','')+'\ndrop function if exists public.handle_audit_log();\n'
p=out/'diagnostic-audit-trigger-reorder.sql';p.write_text(s);results.append(run(p))
for f in sorted(root.glob('*.sql')):
 if f.name>'20260822130000_fix_audit_and_multiclinic_rls.sql':
  r=run(f);results.append(r)
  if r['exit']:break
(out/'continue-results.json').write_text(json.dumps(results,indent=2))
