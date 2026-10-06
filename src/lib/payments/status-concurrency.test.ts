import {beforeEach,describe,it,expect,vi} from "vitest";
const db=vi.hoisted(()=>({from:vi.fn()}));const audit=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>db}));
vi.mock("@/lib/audit",()=>({recordAudit:audit}));
import {transitionPaymentStatus} from "./status";
const payment={id:"p",clinic_id:"c",status:"pending",amount:100,provider:"manual",paid_at:null,paid_by:null,provider_reference:null,metadata:{original:true}};
const write={update:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),select:vi.fn().mockReturnThis(),maybeSingle:vi.fn()};
beforeEach(()=>{vi.clearAllMocks();const read={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:payment,error:null})};db.from.mockReturnValueOnce(read).mockReturnValue(write);});
describe("payment compare-and-set",()=>{
 it("refuses a stale read instead of overwriting another worker's payment",async()=>{write.maybeSingle.mockResolvedValue({data:null,error:null});await expect(transitionPaymentStatus({clinicId:"c",paymentId:"p",to:"failed"})).rejects.toMatchObject({status:409,code:"payment_conflict"});expect(write.eq).toHaveBeenCalledWith("status","pending");expect(write.eq).toHaveBeenCalledWith("clinic_id","c");expect(audit).not.toHaveBeenCalled();});
 it("audits a successful scoped transition and preserves metadata",async()=>{write.maybeSingle.mockResolvedValue({data:{id:"p"},error:null});await expect(transitionPaymentStatus({clinicId:"c",paymentId:"p",to:"paid",actorId:"actor",metadata:{confirmation:true}})).resolves.toEqual({ok:true});expect(write.update).toHaveBeenCalledWith(expect.objectContaining({metadata:{original:true,confirmation:true}}));expect(audit).toHaveBeenCalledOnce();});
});
