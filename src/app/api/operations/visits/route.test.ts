import {beforeEach,describe,it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
const db=vi.hoisted(()=>({rpc:vi.fn()}));const guard=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>db}));
vi.mock("@/lib/auth/guards",()=>({requireRoles:guard}));
import {POST,PATCH} from "./route";
import {ApiError} from "@/lib/api/errors";
const id="11111111-1111-4111-8111-111111111111";
function req(body:unknown,method="POST"){return new NextRequest("http://localhost/api/operations/visits",{method,body:JSON.stringify(body)});}
const body={patientId:id,doctorId:id,serviceId:id,idempotencyKey:id};
beforeEach(()=>{vi.clearAllMocks();guard.mockResolvedValue({clinicId:"verified-clinic",profileId:"verified-actor",roles:["receptionist"]});db.rpc.mockResolvedValue({data:{id,queue_number:1},error:null});});
describe("walk-in API boundary",()=>{
 it("uses session identity and the transactional engine",async()=>{expect((await POST(req(body))).status).toBe(201);expect(db.rpc).toHaveBeenCalledWith("register_walk_in",expect.objectContaining({p_clinic:"verified-clinic",p_actor:"verified-actor",p_key:id,p_patient:id}));});
 it.each(["clinicId","actorId","amount","paymentStatus"])("rejects browser-controlled %s",async(field)=>{expect((await POST(req({...body,[field]:"forged"}))).status).toBe(400);expect(db.rpc).not.toHaveBeenCalled();});
 it("does not claim saved after a database failure",async()=>{db.rpc.mockResolvedValue({data:null,error:{code:"40001"}});const res=await POST(req(body));expect(res.status).toBe(409);expect((await res.json()).ok).toBe(false);});
 it("rejects unauthorized callers before invoking the engine",async()=>{guard.mockRejectedValue(new ApiError(403,"Denied"));expect((await POST(req(body))).status).toBe(403);expect(db.rpc).not.toHaveBeenCalled();});
 it("passes expected state for concurrent queue edits",async()=>{expect((await PATCH(req({id,expectedStatus:"waiting",status:"called"},"PATCH"))).status).toBe(200);expect(db.rpc).toHaveBeenCalledWith("transition_visit",expect.objectContaining({p_expected:"waiting",p_status:"called",p_clinic:"verified-clinic",p_actor:"verified-actor"}));});
});
