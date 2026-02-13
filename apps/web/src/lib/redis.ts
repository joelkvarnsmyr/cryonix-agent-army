import Redis from 'ioredis';

const getRedisUrl = () => {
    if (process.env.KV_URL) return process.env.KV_URL;
    return 'redis://localhost:6379';
};

export const redis = new Redis(getRedisUrl());
