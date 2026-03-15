declare module 'pg' {
    export class Client {
        constructor(config?: { connectionString?: string });
        connect(): Promise<void>;
        query(text: string, values?: any[]): Promise<{ rows: any[]; rowCount: number }>;
        end(): Promise<void>;
    }
}
