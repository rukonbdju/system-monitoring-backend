import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import si from 'systeminformation';

// --- Configuration ---
const PORT = process.env.PORT || 5000;
const UPDATE_INTERVAL_MS = process.env.UPDATE_INTERVAL_MS || 2000;

// --- App Setup ---
const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// --- Interfaces ---
interface SystemStats {
    cpuUsage: number;
    cpuTemp: number;
    memoryUsed: number;
    memoryTotal: number;
    storageUsed: number;
    storageTotal: number;
    networkUp: number;
    networkDown: number;
    uptime: number;
}

// --- Main Data Loop ---
io.on('connection', async (socket) => {
    console.log('Frontend connected:', socket.id);

    try {
        // Fetch static data once on connection
        const [osInfo, netInterfaces] = await Promise.all([
            si.osInfo(),
            si.networkInterfaces()
        ]);

        // Find the main non-internal interface
        const mainInterface = Array.isArray(netInterfaces)
            ? netInterfaces.find(i => !i.internal && i.ip4)
            : null;

        socket.emit('vm-info', {
            instanceId: osInfo.hostname,
            status: 'Online',
            region: 'Local', // Region is cloud-specific; defaulting to Local
            ip: mainInterface?.ip4 || '127.0.0.1',
            os: `${osInfo.distro} ${osInfo.release}`,
            kernel: osInfo.kernel
        });
    } catch (error) {
        console.error("Error fetching static info:", error);
    }

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

// Broadcast real stats
setInterval(async () => {
    try {
        // Fetch all dynamic metrics in parallel
        const [cpuLoad, cpuTemp, mem, fsSize, networkStats, processes] = await Promise.all([
            si.currentLoad(),
            si.cpuTemperature(),
            si.mem(),
            si.fsSize(),
            si.networkStats(),
            si.processes()
        ]);

        // 1. Storage: Find the main drive (usually mounted on / or C:)
        // We sum up used/total if there are multiple partitions, or just take the biggest one
        const mainDrive = fsSize.length > 0
            ? fsSize.reduce((prev, current) => (prev.size > current.size) ? prev : current)
            : { used: 0, size: 0 };

        // 2. Network: Sum up traffic from all active interfaces
        // rx_sec = bytes received per second. Convert to Mbps: (bytes * 8) / 1,000,000
        const netRxSec = networkStats.reduce((acc, iface) => acc + (iface.rx_sec || 0), 0);
        const netTxSec = networkStats.reduce((acc, iface) => acc + (iface.tx_sec || 0), 0);

        const stats: SystemStats = {
            cpuUsage: parseFloat(cpuLoad.currentLoad.toFixed(1)),
            // Some VMs/Containers don't expose temp; fallback to -1 or 0
            cpuTemp: cpuTemp.main || 0,
            memoryUsed: parseFloat((mem.active / (1024 ** 3)).toFixed(1)), // GB
            memoryTotal: parseFloat((mem.total / (1024 ** 3)).toFixed(1)), // GB
            storageUsed: parseFloat((mainDrive.used / (1024 ** 3)).toFixed(1)), // GB
            storageTotal: parseFloat((mainDrive.size / (1024 ** 3)).toFixed(1)), // GB
            networkDown: parseFloat(((netRxSec * 8) / 1000000).toFixed(1)), // Mbps
            networkUp: parseFloat(((netTxSec * 8) / 1000000).toFixed(1)),   // Mbps
            uptime: si.time().uptime
        };

        // 3. Processes: Sort by CPU usage and take top 5
        const topProcesses = processes.list
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 5)
            .map(p => ({
                pid: p.pid,
                name: p.name,
                user: p.user,
                cpu: parseFloat(p.cpu.toFixed(1)),
                mem: parseFloat(p.mem.toFixed(1)),
                status: p.state === 'sleeping' ? 'Sleeping' : 'Running' // Simplify states
            }));

        io.emit('stats', stats);
        io.emit('processes', topProcesses);

    } catch (error) {
        console.error("Error fetching stats:", error);
    }

}, Number(UPDATE_INTERVAL_MS));

// --- Start Server ---
httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});