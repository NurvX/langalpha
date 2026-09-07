import React from 'react';
import { getToolIcon } from './toolDisplayConfig';
import { parseDirectToolName } from '../utils/directTools';
import { DirectToolRowMark } from './mcp/DirectToolMark';

/**
 * The icon for a tool call: a direct MCP tool wears its vendor's mark,
 * everything else keeps its lucide glyph. One component so the same call looks
 * the same in the timeline row, the message body and the detail header, and so
 * the vendor lookup hook only mounts on the rows that need it.
 */
export function ToolIcon({ toolName, args, className, style }: {
  toolName: string;
  args?: Record<string, unknown>;
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement {
  const direct = parseDirectToolName(toolName);
  if (direct) return <DirectToolRowMark server={direct.server} className={className} style={style} />;
  const IconComponent = getToolIcon(toolName, args);
  return <IconComponent className={className} style={style} />;
}
