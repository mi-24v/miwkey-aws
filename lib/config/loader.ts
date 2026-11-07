import {MiwkeyMeilisearchProps, MiwkeyNetworkStackProps} from "../types/stackprops";
import * as fs from "fs";
import {z} from "zod";
import {MiwkeyIp} from "../types/miwkey-ip";
import * as path from "path";
import {Environment} from "aws-cdk-lib";


export function loadNetworkProps(): MiwkeyNetworkStackProps {
    const ipConfSchema = z.object({
        vpcCIDR: z.string(),
        subnetCIDRs: z.array(z.object({
            region: z.string(),
            ip: z.string()
        })),
        peerVpcId: z.string().optional(),
        peerDestCIDR: z.string().optional()
    })
    const netPropsSchema = z.object({
        certificateArn: z.string().regex(/^arn:aws:(.+):(.+):(\d+):(.+)[:\/](.+)$/g)
    })
    const rawIpConf = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "ipAddress.json"), {encoding: "utf-8"}))
    const rawNetProps = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "networkprops.json"), {encoding: "utf-8"}))
    return {
        ipAddresses: ipConfSchema.parse(rawIpConf) as MiwkeyIp,
        certificateArn: netPropsSchema.parse(rawNetProps).certificateArn
    }
}

export function loadEnvironment() {
    const environmentSchema = z.object({
        account: z.string().regex(/^\d{12}/g),
        region: z.string()
    })
    const rawEnv = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "environment.json"), {encoding: "utf-8"}))
    return environmentSchema.parse(rawEnv) as Environment
}

export function loadMeilisearchProps(){
    const meilisearchPropsSchema = z.object({
        targetFQDN: z.string().regex(/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/)
    })
    const rawProps = JSON.parse(fs.readFileSync(path.join(__dirname, ".", "meilisearchprops.json"), {encoding: "utf-8"}))
    return meilisearchPropsSchema.parse(rawProps) as MiwkeyMeilisearchProps
}

// Only non-secret inputs belong here. Secret values are provisioned out of band.
export const extensionPropsSchema = z.object({
    stage: z.enum(['bootstrap', 'service', 'client', 'scheduled']),
    fqdn: z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
    cloudflareZoneId: z.string().regex(/^[a-f0-9]{32}$/),
    serviceName: z.string().min(1).max(255).regex(/^[a-zA-Z0-9_-]+$/),
    namespace: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    image: z.string().regex(/^ghcr\.io\/mi-24v\/miwkey-extension@sha256:[a-f0-9]{64}$/),
    accountEmail: z.string().email(),
    alertEmail: z.string().email().optional(),
    monitoringStart: z.string().datetime({precision: 0}).optional(),
    renewalDays: z.number().int().positive().default(30),
    warningDays: z.number().int().positive(),
    staging: z.boolean().default(false),
    budgets: z.object({
        mainCpu: z.number().int().min(1280),
        mainMemory: z.number().int().min(1676),
        extensionCpu: z.number().int().positive(),
        extensionMemory: z.number().int().positive(),
        appCpu: z.number().int().positive(),
        appMemory: z.number().int().positive(),
    }).strict(),
}).strict().superRefine((value, ctx) => {
    const b = value.budgets;
    const check = (ok: boolean, message: string) => {
        if (!ok) ctx.addIssue({code: z.ZodIssueCode.custom, message});
    };
    check(value.warningDays < value.renewalDays, 'warningDays must be shorter than renewalDays');
    check(b.extensionCpu >= b.appCpu + 256, 'Reserve at least 256 CPU for each proxy');
    check(b.extensionMemory >= b.appMemory + 64, 'Reserve at least 64 MiB for each proxy');
    check(b.mainCpu + b.extensionCpu <= 2048, 'Tasks must fit the smallest candidate host CPU');
    check(b.mainMemory + b.extensionMemory <= 3584, 'Leave at least 512 MiB host memory headroom; measured capacity is still required');
    check(!value.staging || value.stage === 'bootstrap', 'Staging secrets exist only during bootstrap');
    check(value.stage !== 'scheduled' || !!value.alertEmail, 'Scheduled renewal requires an alert recipient');
    check(value.stage !== 'scheduled' || !!value.monitoringStart, 'Scheduled monitoring requires an explicit UTC activation time');
    check(value.stage !== 'scheduled' || value.warningDays > 3, 'Warning horizon must exceed the missing-job detection window');
});

export type ExtensionProps = z.infer<typeof extensionPropsSchema>;

export function parseExtensionProps(value: unknown): ExtensionProps {
    return extensionPropsSchema.parse(value);
}

export function loadExtensionProps(file = path.join(__dirname, 'extensionprops.json')): ExtensionProps | undefined {
    try {
        return parseExtensionProps(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

export function parseHostProps(value: unknown): {amiId: string} {
    return z.object({amiId: z.string().regex(/^ami-(?:[a-f0-9]{8}|[a-f0-9]{17})$/)}).strict().parse(value);
}

export function loadHostProps(file = path.join(__dirname, 'hostprops.json')): {amiId: string} {
    return parseHostProps(JSON.parse(fs.readFileSync(file, 'utf8')));
}
