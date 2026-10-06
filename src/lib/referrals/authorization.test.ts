import { describe, it, expect, vi, beforeEach } from "vitest";
const db=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>db}));
import { canDoctorAccessPatientClinicalData, requirePatientClinicalAccess } from "./access";
const ctx={profileId:"actor",clinicId:"clinic",clinicName:"Test",clinicTimezone:"UTC",roles:["doctor" as const],platformAdmin:false};
beforeEach(()=>{vi.clearAllMocks();const chain={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{id:"doctor"},error:null})};db.from.mockReturnValue(chain);});
describe("authoritative clinical access",()=>{
 it("passes the verified actor, patient and clinic to the DB check",async()=>{db.rpc.mockResolvedValue({data:true,error:null});expect((await canDoctorAccessPatientClinicalData("actor","patient","clinic",["doctor"])).level).toBe("own_patient");expect(db.rpc).toHaveBeenCalledWith("doctor_patient_access",{p_actor:"actor",p_patient:"patient",p_clinic:"clinic"});});
 it.each([false,null])("denies when DB does not affirm access (%s)",async(value)=>{db.rpc.mockResolvedValue({data:value,error:null});expect((await canDoctorAccessPatientClinicalData("actor","patient","clinic",["doctor"])).level).toBe("none");});
 it("fails closed on database errors",async()=>{db.rpc.mockResolvedValue({data:true,error:{message:"offline"}});await expect(requirePatientClinicalAccess(ctx,"patient")).rejects.toMatchObject({status:403});});
 it.each(["owner","admin","manager","receptionist"] as const)("does not give %s a clinical bypass",async(role)=>{expect((await canDoctorAccessPatientClinicalData("actor","patient","clinic",[role])).level).toBe("none");expect(db.rpc).not.toHaveBeenCalled();});
 it("denies if doctor linkage disappears after the access check",async()=>{db.rpc.mockResolvedValue({data:true,error:null});db.from.mockReturnValue({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:null,error:null})});await expect(requirePatientClinicalAccess(ctx,"patient")).rejects.toMatchObject({status:403});});
});
