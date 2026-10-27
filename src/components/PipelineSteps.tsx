import { Check, LoaderCircle, X } from 'lucide-react'
import type { PipelineStage } from '../types'

export function PipelineSteps({ stages, compact = false }: { stages: PipelineStage[]; compact?: boolean }) {
  return (
    <div className={`pipeline-steps ${compact ? 'pipeline-steps-compact' : ''}`}>
      {stages.map((stage, index) => (
        <div className="pipeline-step-wrap" key={stage.key}>
          <div className={`pipeline-step pipeline-step-${stage.status}`}>
            <div className="pipeline-node">
              {stage.status === 'success' ? (
                <Check size={compact ? 13 : 16} strokeWidth={3} />
              ) : stage.status === 'running' ? (
                <LoaderCircle size={compact ? 14 : 17} className="spin" />
              ) : stage.status === 'failed' ? (
                <X size={compact ? 13 : 16} strokeWidth={3} />
              ) : (
                <span>{index + 1}</span>
              )}
            </div>
            <div className="pipeline-step-copy">
              <strong>{stage.name}</strong>
              {!compact && <span>{stage.description}</span>}
            </div>
          </div>
          {index < stages.length - 1 && (
            <div
              className={`pipeline-connector ${
                stage.status === 'success' ? 'pipeline-connector-done' : ''
              }`}
            />
          )}
        </div>
      ))}
    </div>
  )
}
