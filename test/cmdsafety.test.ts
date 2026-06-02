import { describe, it, expect } from 'vitest'
import { isAppKiller, isDangerousCommand } from '../src/main/cmdsafety'

describe('isAppKiller — 会杀死应用自身的命令', () => {
  it('拦截按映像名批量杀 node/electron', () => {
    expect(isAppKiller('taskkill /f /im node.exe')).toBe(true)
    expect(isAppKiller('taskkill /im electron.exe')).toBe(true)
    expect(isAppKiller('killall node')).toBe(true)
    expect(isAppKiller('pkill electron')).toBe(true)
  })
  it('放行按 PID 精确结束', () => {
    expect(isAppKiller('taskkill /f /pid 12345')).toBe(false)
    expect(isAppKiller('kill 12345')).toBe(false)
  })
})

describe('isDangerousCommand — 不可逆破坏命令', () => {
  it.each([
    'rm -rf /',
    'rm -fr node_modules',
    'shutdown /s',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda'
  ])('拦截: %s', (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(true)
  })
  it.each(['ls -la', 'npm test', 'git status', 'echo hello'])('放行: %s', (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(false)
  })
})
