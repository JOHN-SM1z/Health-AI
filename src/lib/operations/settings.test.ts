import {describe,it,expect,vi} from "vitest";
const db=vi.hoisted(()=>({from:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminClient:()=>db}));
import {parseOperationsSettings} from "./settings";
import {requireScheduledBookings} from "./server";
function setting(value:unknown,error:unknown=null){db.from.mockReturnValue({select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:value===null?null:{value},error})});}
describe("clinic operating model",()=>{
 it("defaults to walk-in; invalid configuration cannot enable booking",()=>{expect(parseOperationsSettings(null).mode).toBe("walk_in");expect(parseOperationsSettings({mode:"unknown"}).mode).toBe("walk_in");});
 it("rejects booking in a walk-in clinic",async()=>{setting(null);await expect(requireScheduledBookings("clinic")).rejects.toMatchObject({status:409,code:"walk_in_only"});});
 it.each(["mixed","scheduled"])("permits explicitly configured %s booking",async(mode)=>{setting({mode});await expect(requireScheduledBookings("clinic")).resolves.toBeUndefined();});
 it("fails closed if the settings store is unavailable",async()=>{setting(null,{message:"offline"});await expect(requireScheduledBookings("clinic")).rejects.toMatchObject({status:503});});
});
