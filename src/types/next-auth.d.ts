import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      departmentId: number | null;
      sessionVersion: number;
    } & DefaultSession["user"];
  }
  interface User {
    role: string;
    departmentId: number | null;
    sessionVersion: number;
  }
}