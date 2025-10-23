import { z } from "zod";
import { registerSchema } from "./zod/registerSchema.js";

export type Register = z.infer<typeof registerSchema>;