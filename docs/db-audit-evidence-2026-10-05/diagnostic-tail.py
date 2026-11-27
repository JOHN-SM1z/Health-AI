from pathlib import Path
import subprocess,json
out=Path('/private/tmp/health-ai-db-audit.0xe3j2');root=Path('/Users/jahonshoh/Health-AI/supabase/migrations')
base=['psql','-X','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1','-1']
s=(root/'20260920000002_referral_handoff_workflow.sql').read_text()
a=s.index('-- ---------- 2.');b=s.index('-- ---------- 4.')
s=s[:a]+s[b:]
p=out/'diagnostic-handoff-without-missing-table.sql';p.write_text(s)
r=subprocess.run(base+['-f',str(p)],capture_output=True,text=True)
print(json.dumps({'probe':'enum same-transaction after omitting missing-table statements','exit':r.returncode,'error':r.stderr[-1800:]}))
# Commit the enum declaration separately only to inspect later policies.
p=out/'diagnostic-enum.sql';p.write_text(s[:s.index('-- ---------- 4.')])
r=subprocess.run(base+['-f',str(p)],capture_output=True,text=True);assert r.returncode==0,r.stderr
p=out/'diagnostic-handoff-policies.sql';p.write_text(s[s.index('-- ---------- 4.'):])
r=subprocess.run(base+['-f',str(p)],capture_output=True,text=True);assert r.returncode==0,r.stderr
r=subprocess.run(base+['-f',str(root/'20260920000003_referral_lifecycle_hardening.sql')],capture_output=True,text=True);assert r.returncode==0,r.stderr
print('Later referral policies/triggers loaded for diagnostics. clinical_notes remains absent. Repository unchanged.')
