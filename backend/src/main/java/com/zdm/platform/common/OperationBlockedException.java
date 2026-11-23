package com.zdm.platform.common;

/** A known business prerequisite failed. Authorization and infrastructure errors stay separate. */
public class OperationBlockedException extends IllegalArgumentException {
  public OperationBlockedException(String message) {
    super(message);
  }
}
