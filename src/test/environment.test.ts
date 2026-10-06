import {afterEach,describe,it,expect,vi} from "vitest";
import {loadTestEnvironment} from "./environment";
afterEach(()=>vi.unstubAllEnvs());
describe("test database safety",()=>{
 it.each(["SUPABASE_URL","NEXT_PUBLIC_SUPABASE_URL"])("rejects hosted %s before fixture tests can run",key=>{vi.stubEnv(key,"https://example.invalid");expect(()=>loadTestEnvironment()).toThrow("must use a loopback host");});
 it("accepts explicit local endpoints",()=>{vi.stubEnv("SUPABASE_URL","http://127.0.0.1:54321");vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL","http://localhost:54321");expect(()=>loadTestEnvironment()).not.toThrow();});
});
